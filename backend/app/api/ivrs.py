"""AURA call API - counsellor-generated wellness calls to a victim, plus the
earlier victim-self-initiated path (kept working, no longer the victim UI's
entry point). Simulates a call entirely in the browser: no real phone
number, SIM, or telecom gateway involved anywhere in this module.

    Counsellor -> POST /call/generate -> call session created -> victim's
    notification WebSocket receives "incoming_call" in real time -> victim
    answers -> STT (Groq Whisper) -> Groq chat -> TTS (ElevenLabs, falling
    back to Groq TTS) -> repeat until the victim or counsellor ends it.

Real-time state (ringing/listening/thinking/speaking/ended) is pushed over a
per-call WebSocket as it actually happens - it is never simulated or sent
ahead of the real event that caused it.
"""
import logging
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import ivrs_store
from ..database import get_db
from ..database.models import User
from ..security.auth import decode_token, get_current_user, require_role
from ..security.authz import can_access_victim
from ..services import chatbot_service, elevenlabs_tts, ivrs_conversation
from .chat import resolve_aura_id

logger = logging.getLogger("aura.ivrs_api")
router = APIRouter(prefix="/api/ivrs", tags=["ivrs"])

MAX_TEXT_CHARS = 2000


# --- Schemas -----------------------------------------------------------


class StartCallRequest(BaseModel):
    reason_key: str = Field(min_length=1)
    custom_reason: Optional[str] = Field(default=None, max_length=200)


class GenerateCallRequest(BaseModel):
    victim_aura_id: str = Field(min_length=1)
    reason_key: str = Field(min_length=1)
    custom_message: Optional[str] = Field(default=None, max_length=1000)
    language: Optional[str] = None


class TextTurnRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)


def _synthesize(text: str):
    """ElevenLabs when it actually works on this account, else Groq TTS.
    Returns (audio_bytes | None, content_type, available)."""
    if elevenlabs_tts.is_configured():
        el = elevenlabs_tts.synthesize(text)
        if el.available and el.audio:
            return el.audio, el.content_type, True
        logger.info("ElevenLabs TTS unavailable (%s); falling back to Groq TTS.", el.error)

    groq_result = chatbot_service.synthesize_speech(text)
    if groq_result.get("success"):
        return groq_result["audio"], groq_result["content_type"], True
    return None, "audio/mpeg", False


# --- WebSocket registries -------------------------------------------------
# In-memory only, per running process - consistent with the rest of the
# app's realtime state (voice sessions, chat history) not being clustered.

_call_sockets: Dict[str, List[WebSocket]] = {}
# One victim can have this open on multiple tabs/devices - a list per aura_id.
_notify_sockets: Dict[str, List[WebSocket]] = {}


async def _broadcast_call(call_id: str, message: Dict) -> None:
    for ws in list(_call_sockets.get(call_id, [])):
        try:
            await ws.send_json(message)
        except Exception:  # noqa: BLE001 - a dead socket must not break the call
            pass


async def _notify_victim(victim_aura_id: str, message: Dict) -> None:
    for ws in list(_notify_sockets.get(victim_aura_id, [])):
        try:
            await ws.send_json(message)
        except Exception:  # noqa: BLE001
            pass


@router.websocket("/call/{call_id}/ws")
async def call_events(websocket: WebSocket, call_id: str):
    """Pushes real avatar-state and turn events for this call as they
    happen (attend/audio/text/end all broadcast here). Carries no audio -
    audio upload and playback go over the REST endpoints below."""
    await websocket.accept()
    _call_sockets.setdefault(call_id, []).append(websocket)
    try:
        call = ivrs_store.get_call(call_id)
        if call:
            await websocket.send_json({"type": "state", "state": call["status"]})
        while True:
            # This socket is server->client only; a client message is just a
            # keepalive ping, discarded.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        sockets = _call_sockets.get(call_id, [])
        if websocket in sockets:
            sockets.remove(websocket)


@router.websocket("/notify/ws")
async def notify_events(websocket: WebSocket, token: str = Query(...)):
    """The victim's standing 'is a call arriving' channel - opened once when
    their dashboard loads. A real JWT is required (as a query param, since
    browsers can't attach custom headers to a WebSocket handshake); an
    invalid or missing token closes the connection immediately rather than
    silently listening under no identity."""
    payload = decode_token(token)
    if not payload or not payload.get("aura_id"):
        await websocket.close(code=4401)
        return
    aura_id = payload["aura_id"]

    await websocket.accept()
    _notify_sockets.setdefault(aura_id, []).append(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        sockets = _notify_sockets.get(aura_id, [])
        if websocket in sockets:
            sockets.remove(websocket)


# --- Routes --------------------------------------------------------------


@router.get("/reasons")
async def list_reasons():
    return {
        "success": True,
        "reasons": [
            {"key": key, "label": r["label"], "emoji": r["emoji"], "message": r["opening"]}
            for key, r in ivrs_conversation.CALL_REASONS.items()
        ],
    }


@router.get("/status")
async def status():
    """Honest capability report: which real backends this call actually has."""
    return {
        "success": True,
        "groq_configured": chatbot_service.is_configured(),
        "elevenlabs_tts_configured": elevenlabs_tts.is_configured(),
        "ready": chatbot_service.is_configured(),
        "note": (
            "Set GROQ_API_KEY to enable AURA's responses."
            if not chatbot_service.is_configured()
            else "Call system is configured."
        ),
    }


@router.post("/call/generate")
async def generate_call(
    payload: GenerateCallRequest,
    db: Session = Depends(get_db),
    counsellor: User = Depends(require_role("counsellor")),
):
    """The real counsellor-facing entry point: pick an authorised victim and
    a reason, and this places the call to them in real time. Refuses to
    generate a call for a victim this counsellor isn't actually authorised
    for - authorization is enforced here, server-side, not just hidden by
    the frontend only showing assigned victims in the picker."""
    if payload.reason_key not in ivrs_conversation.CALL_REASONS:
        raise HTTPException(status_code=422, detail="Unknown call reason.")
    if payload.reason_key == "custom" and not (payload.custom_message or "").strip():
        raise HTTPException(status_code=422, detail="A custom message is required for this reason.")
    if not can_access_victim(counsellor, payload.victim_aura_id, db):
        raise HTTPException(status_code=403, detail="You are not authorised for this victim.")

    message = ivrs_conversation.opening_line(payload.reason_key, payload.custom_message)
    call_id = ivrs_store.start_call(
        payload.victim_aura_id,
        payload.reason_key,
        payload.custom_message,
        message,
        counsellor_user_id=counsellor.id,
        language=payload.language,
    )
    ivrs_store.add_turn(call_id, "aura", message)
    reason = ivrs_conversation.CALL_REASONS[payload.reason_key]
    reason_label = payload.custom_message.strip() if payload.reason_key == "custom" else reason["label"]

    await _notify_victim(
        payload.victim_aura_id,
        {
            "type": "incoming_call",
            "call_id": call_id,
            "reason_key": payload.reason_key,
            "reason_label": reason_label,
            "reason_emoji": reason["emoji"],
            "message": message,
        },
    )

    return {
        "success": True,
        "call_id": call_id,
        "victim_aura_id": payload.victim_aura_id,
        "reason_key": payload.reason_key,
        "reason_label": reason_label,
        "message": message,
        "status": "ringing",
    }


@router.post("/call/start")
async def start_call(payload: StartCallRequest, aura_id: str = Depends(resolve_aura_id)):
    """Self-initiated call (no counsellor) - kept for compatibility; the
    current victim UI no longer exposes this, only reacts to /call/generate."""
    if payload.reason_key not in ivrs_conversation.CALL_REASONS:
        raise HTTPException(status_code=422, detail="Unknown call reason.")

    message = ivrs_conversation.opening_line(payload.reason_key, payload.custom_reason)
    call_id = ivrs_store.start_call(aura_id, payload.reason_key, payload.custom_reason, message)
    ivrs_store.add_turn(call_id, "aura", message)
    reason = ivrs_conversation.CALL_REASONS[payload.reason_key]

    return {
        "success": True,
        "call_id": call_id,
        "reason_key": payload.reason_key,
        "reason_label": payload.custom_reason.strip() if (payload.reason_key == "custom" and payload.custom_reason) else reason["label"],
        "reason_emoji": reason["emoji"],
        "opening_text": message,
        "status": "ringing",
    }


@router.post("/call/{call_id}/attend")
async def attend_call(call_id: str):
    call = ivrs_store.get_call(call_id)
    if not call:
        raise HTTPException(status_code=404, detail="Call not found.")
    ivrs_store.set_status(call_id, "answered", answered=True)
    await _broadcast_call(call_id, {"type": "state", "state": "listening"})
    opening_turn = next((t for t in call["turns"] if t["role"] == "aura"), None)
    return {"success": True, "status": "answered", "opening_text": opening_turn["text"] if opening_turn else ""}


@router.post("/call/{call_id}/decline")
async def decline_call(call_id: str):
    call = ivrs_store.get_call(call_id)
    if not call:
        raise HTTPException(status_code=404, detail="Call not found.")
    ivrs_store.set_status(call_id, "declined", ended=True)
    await _broadcast_call(call_id, {"type": "state", "state": "ended"})
    return {"success": True, "status": "declined"}


async def _handle_turn(call_id: str, user_text: str) -> Dict:
    """Shared logic for both the audio and text turn endpoints: store the
    real user turn, get Groq's reply grounded in this call's real history,
    store it, and broadcast the state changes. The reply is not voiced here -
    the browser fetches /audio-reply for the exact text once it has it, so a
    turn is never synthesized twice."""
    call = ivrs_store.get_call(call_id)
    if not call:
        raise HTTPException(status_code=404, detail="Call not found.")

    ivrs_store.add_turn(call_id, "user", user_text)
    await _broadcast_call(call_id, {"type": "turn", "role": "user", "text": user_text})
    await _broadcast_call(call_id, {"type": "state", "state": "thinking"})

    history = ivrs_store.history_for_groq(call_id)[:-1]  # exclude the turn just added; passed as `user_message`
    result = ivrs_conversation.reply(call["reason_key"], call["custom_reason"], history, user_text)
    aura_text = result.reply or chatbot_service.USER_FACING_ERROR
    ivrs_store.add_turn(call_id, "aura", aura_text)

    await _broadcast_call(call_id, {"type": "state", "state": "speaking"})
    await _broadcast_call(call_id, {"type": "turn", "role": "aura", "text": aura_text})
    await _broadcast_call(call_id, {"type": "state", "state": "idle"})

    return {
        "success": True,
        "user_text": user_text,
        "aura_text": aura_text,
        "aura_status": result.status,
        "tts_available": elevenlabs_tts.is_configured() or chatbot_service.is_configured(),
    }


@router.post("/call/{call_id}/text")
async def send_text_turn(call_id: str, payload: TextTurnRequest):
    return await _handle_turn(call_id, payload.text.strip())


@router.post("/call/{call_id}/audio")
async def send_audio_turn(call_id: str, audio: UploadFile = File(...)):
    raw = await audio.read()
    transcript = chatbot_service.transcribe(raw, audio.filename or "audio.webm")
    if not transcript.get("success"):
        return {
            "success": False,
            "error": "transcription_failed",
            "message": "Sorry, I couldn't hear that clearly. Could you try again?",
        }
    user_text = (transcript.get("text") or "").strip()
    if not user_text:
        return {
            "success": False,
            "error": "empty_transcript",
            "message": "I didn't catch that - could you say it again?",
        }
    return await _handle_turn(call_id, user_text)


@router.get("/call/{call_id}/audio-reply")
async def get_audio_reply(call_id: str, text: str):
    """Fetches spoken audio for one exact AURA line, on demand - kept
    separate from the turn endpoints above so the browser can play audio via
    a plain <audio src> without juggling base64. Prefers ElevenLabs, falls
    back to Groq TTS (see _synthesize) so the call is voiced either way."""
    if len(text) > 2000:
        raise HTTPException(status_code=422, detail="Text too long.")
    audio, content_type, available = _synthesize(text)
    if not available or not audio:
        raise HTTPException(status_code=503, detail="Speech synthesis unavailable.")
    return Response(content=audio, media_type=content_type)


@router.post("/call/{call_id}/end")
async def end_call(call_id: str):
    call = ivrs_store.get_call(call_id)
    if not call:
        raise HTTPException(status_code=404, detail="Call not found.")
    ivrs_store.set_status(call_id, "completed", ended=True)
    await _broadcast_call(call_id, {"type": "state", "state": "ended"})
    return {"success": True, "status": "completed"}


@router.get("/call/{call_id}")
async def get_call(
    call_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    call = ivrs_store.get_call(call_id)
    if not call:
        raise HTTPException(status_code=404, detail="Call not found.")
    if not can_access_victim(user, call["aura_id"], db):
        raise HTTPException(status_code=403, detail="You are not authorised for this call.")
    return {"success": True, **call}


@router.get("/calls")
async def get_calls(aura_id: str = Depends(resolve_aura_id)):
    """A victim's own call history."""
    return {"success": True, "calls": ivrs_store.list_calls(aura_id)}


@router.get("/calls/generated")
async def get_generated_calls(counsellor: User = Depends(require_role("counsellor"))):
    """Calls this counsellor has actually placed - their 'AURA Call' history view."""
    return {"success": True, "calls": ivrs_store.list_calls_by_counsellor(counsellor.id)}


@router.get("/calls/{victim_aura_id}/history")
async def get_victim_call_history(
    victim_aura_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    """Call history for one victim, visible to that victim, their assigned
    counsellor(s), their linked guardian(s), or an admin - the same
    authorization rule used everywhere else this data is exposed."""
    if not can_access_victim(user, victim_aura_id, db):
        raise HTTPException(status_code=403, detail="You are not authorised for this victim.")
    return {"success": True, "calls": ivrs_store.list_calls(victim_aura_id)}
