"""AURA Companion chat API.

    Browser -> AURA FastAPI -> chatbot_service -> Groq -> back

The browser never sees GROQ_API_KEY and never contacts Groq directly.

SESSION ISOLATION: every conversation is keyed by (aura_id, session_id).
A caller can only ever read or write their own conversation, because the
aura_id is taken from the authenticated token and never from the request body.
"""
import json
import logging
import time
import uuid
from collections import defaultdict, deque
from threading import Lock
from typing import Deque, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, File, Header, HTTPException, Response, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..services import chat_safety, chatbot_service, elevenlabs_tts

logger = logging.getLogger("aura.chat_api")
router = APIRouter(prefix="/api/chat", tags=["companion"])

# Conversations are held in memory, not the database, and scoped to
# (aura_id, session_id). For disclosures of abuse this is the more protective
# default: nothing is written to disk, and history disappears when the process
# restarts or the user clears it. Persisting these transcripts should be an
# explicit, consented decision - not something that happens by default.
_conversations: Dict[Tuple[str, str], Deque[Dict]] = defaultdict(lambda: deque(maxlen=40))
_conversation_lock = Lock()

# Simple in-process rate limiting. Sufficient for a single-instance prototype;
# a multi-instance deployment needs a shared store (Redis) instead.
_rate_state: Dict[str, Deque[float]] = defaultdict(lambda: deque(maxlen=60))
RATE_LIMIT_PER_MINUTE = 20

MAX_MESSAGE_CHARS = 4000


# --- Schemas ---------------------------------------------------------------


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=MAX_MESSAGE_CHARS)
    session_id: Optional[str] = None
    language: Optional[str] = None
    # True for the voice conversation - asks the model for short, spoken-
    # style replies. The text Companion leaves this False.
    voice_mode: bool = False
    # Caller-generated id for this conversational turn (the voice UI mints
    # one per user utterance). Echoed back on every SSE event so the client
    # can tell a stale, since-interrupted turn's events apart from the
    # current one without relying only on fetch-abort timing.
    turn_id: Optional[str] = None


class SpeakRequest(BaseModel):
    text: str = Field(min_length=1, max_length=chatbot_service.MAX_TTS_CHARS)


class SafetyCheckRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_MESSAGE_CHARS)


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatResponse(BaseModel):
    response: str
    session_id: str
    status: str
    safety: Optional[Dict] = None
    used_web_search: bool = False


# --- Identity --------------------------------------------------------------


def resolve_aura_id(authorization: Optional[str] = Header(default=None)) -> str:
    """Derives the caller's AURA-ID from their token.

    Taken from the verified token, never from the request body - otherwise a
    caller could simply name someone else's aura_id and read their conversation.

    Falls back to a local identity when auth is not configured, so the
    companion remains usable in the current single-user prototype. In a
    deployment with auth enabled this branch is never taken.
    """
    if not authorization:
        return "local-user"
    try:
        from ..security.auth import decode_token

        token = authorization.split(None, 1)[-1]
        payload = decode_token(token)
        if payload and payload.get("aura_id"):
            return str(payload["aura_id"])
    except Exception:  # noqa: BLE001 - auth is optional in the prototype
        logger.debug("Token could not be decoded for chat; using local identity")
    return "local-user"


def _rate_limited(aura_id: str) -> bool:
    now = time.time()
    bucket = _rate_state[aura_id]
    while bucket and now - bucket[0] > 60:
        bucket.popleft()
    if len(bucket) >= RATE_LIMIT_PER_MINUTE:
        return True
    bucket.append(now)
    return False


# --- Routes ----------------------------------------------------------------


@router.get("/status")
async def status():
    """Whether the companion is usable, without revealing any key material."""
    report = chatbot_service.capability_report()
    return {
        "success": True,
        **report,
        "safety_layer": "enabled",
        "prompt_change_note": chatbot_service.SAFETY_NOTE,
    }


@router.post("", response_model=ChatResponse)
@router.post("/", response_model=ChatResponse)
async def chat(payload: ChatRequest, aura_id: str = Depends(resolve_aura_id)):
    """One conversational turn."""
    message = payload.message.strip()
    if not message:
        raise HTTPException(status_code=422, detail="Message cannot be empty.")

    if _rate_limited(aura_id):
        raise HTTPException(
            status_code=429,
            detail="You're sending messages very quickly. Please wait a moment.",
        )

    session_id = payload.session_id or str(uuid.uuid4())
    key = (aura_id, session_id)

    # Crisis check runs on the user's message regardless of the model's reply,
    # so support resources cannot be suppressed by model behaviour.
    safety = chat_safety.check_message(message)

    with _conversation_lock:
        history = list(_conversations[key])

    result = chatbot_service.chat(message, history, language=payload.language, voice_mode=payload.voice_mode)

    if result.status == "success" and result.reply:
        with _conversation_lock:
            convo = _conversations[key]
            convo.append({"role": "user", "content": message})
            convo.append({"role": "assistant", "content": result.reply})

    safety_payload = None
    if safety.triggered:
        safety_payload = {
            "triggered": True,
            "severity": safety.severity,
            "message": safety.message,
            "resources": safety.resources,
        }

    return ChatResponse(
        response=result.reply or chatbot_service.USER_FACING_ERROR,
        session_id=session_id,
        status=result.status,
        safety=safety_payload,
        used_web_search=result.used_web_search,
    )


@router.post("/stream")
async def chat_stream_endpoint(payload: ChatRequest, aura_id: str = Depends(resolve_aura_id)):
    """Streams one conversational turn as Server-Sent Events, for the voice
    conversation's perceived latency - Aura's reply starts appearing (and can
    start being spoken sentence-by-sentence) before generation finishes.

    Event shapes (one JSON object per `data:` line), every event carrying the
    same `turn_id` the caller sent (or a server-minted one if it didn't), so
    a client can drop events from a turn it has since interrupted:
      {"type": "session", "session_id": "...", "turn_id": "..."}  - once, first
      {"type": "delta", "text": "...", "turn_id": "..."}          - zero or more
      {"type": "safety", "turn_id": "...", ...}                   - only if triggered
      {"type": "done", "turn_id": "...", "used_web_search": false} - once, last

    No tool-call support here (see chatbot_service.chat_stream's docstring) -
    the text Companion keeps using the non-streaming /api/chat for that.
    """
    message = payload.message.strip()
    if not message:
        raise HTTPException(status_code=422, detail="Message cannot be empty.")

    if _rate_limited(aura_id):
        raise HTTPException(
            status_code=429,
            detail="You're sending messages very quickly. Please wait a moment.",
        )

    session_id = payload.session_id or str(uuid.uuid4())
    turn_id = payload.turn_id or str(uuid.uuid4())
    key = (aura_id, session_id)

    safety = chat_safety.check_message(message)

    with _conversation_lock:
        history = list(_conversations[key])

    def _event(payload_obj: Dict) -> str:
        return f"data: {json.dumps({**payload_obj, 'turn_id': turn_id})}\n\n"

    def generate():
        t_start = time.perf_counter()
        first_delta_logged = False
        yield _event({"type": "session", "session_id": session_id})
        full_text = ""
        for delta in chatbot_service.chat_stream(
            message, history, language=payload.language, voice_mode=payload.voice_mode
        ):
            if not first_delta_logged:
                logger.info(
                    "latency turn=%s first_llm_token_ms=%.0f",
                    turn_id,
                    (time.perf_counter() - t_start) * 1000,
                )
                first_delta_logged = True
            full_text += delta
            yield _event({"type": "delta", "text": delta})

        if full_text.strip():
            with _conversation_lock:
                convo = _conversations[key]
                convo.append({"role": "user", "content": message})
                convo.append({"role": "assistant", "content": full_text})

        if safety.triggered:
            yield _event(
                {
                    "type": "safety",
                    "severity": safety.severity,
                    "message": safety.message,
                    "resources": safety.resources,
                }
            )
        logger.info(
            "latency turn=%s llm_stream_complete_ms=%.0f",
            turn_id,
            (time.perf_counter() - t_start) * 1000,
        )
        yield _event({"type": "done", "used_web_search": False})

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/safety-check")
async def safety_check(payload: SafetyCheckRequest, aura_id: str = Depends(resolve_aura_id)):
    """Runs the same deterministic crisis-safety layer used on every chat
    message, for surfaces outside the Companion chat itself (e.g. a Check-In
    note or voice transcript). Never logs the text, only that a category
    fired - identical guarantee to the chat path."""
    if _rate_limited(aura_id):
        raise HTTPException(status_code=429, detail="Please wait a moment before retrying.")
    safety = chat_safety.check_message(payload.text)
    if not safety.triggered:
        return {"success": True, "safety": None}
    return {
        "success": True,
        "safety": {
            "triggered": True,
            "severity": safety.severity,
            "message": safety.message,
            "resources": safety.resources,
        },
    }


@router.get("/history")
async def get_history(session_id: str, aura_id: str = Depends(resolve_aura_id)):
    """Returns only the caller's own conversation."""
    with _conversation_lock:
        messages = list(_conversations.get((aura_id, session_id), []))
    return {
        "success": True,
        "session_id": session_id,
        "messages": messages,
        "empty_state": "Start a conversation with AURA." if not messages else None,
    }


@router.post("/new")
async def new_conversation(aura_id: str = Depends(resolve_aura_id)):
    return {
        "success": True,
        "session_id": str(uuid.uuid4()),
        "empty_state": "Start a conversation with AURA.",
    }


@router.delete("/{session_id}")
async def clear_conversation(session_id: str, aura_id: str = Depends(resolve_aura_id)):
    """Clears one conversation. Scoped to the caller, so a session id alone is
    not enough to wipe someone else's conversation."""
    with _conversation_lock:
        existed = (aura_id, session_id) in _conversations
        _conversations.pop((aura_id, session_id), None)
    return {"success": True, "cleared": existed}


@router.post("/transcribe")
async def transcribe(
    audio: UploadFile = File(...), aura_id: str = Depends(resolve_aura_id)
):
    """Voice-to-text via Groq Whisper, kept in memory (never written to disk)."""
    if _rate_limited(aura_id):
        raise HTTPException(status_code=429, detail="Please wait a moment before retrying.")
    data = await audio.read()
    result = chatbot_service.transcribe(data, audio.filename or "audio.webm")
    if not result.get("success"):
        return {
            "success": False,
            "status": result.get("status", "error"),
            "text": "",
            "message": "Sorry, I couldn't transcribe that. Please try again.",
        }
    return {"success": True, "status": "success", "text": result.get("text", "")}


@router.post("/speak")
async def speak(payload: SpeakRequest, aura_id: str = Depends(resolve_aura_id)):
    """Text-to-speech for one AURA reply, via Groq. Returns raw audio bytes;
    the client plays them directly rather than this route returning JSON, so
    the browser <audio> element can consume the response with no decoding step."""
    if _rate_limited(aura_id):
        raise HTTPException(status_code=429, detail="Please wait a moment before retrying.")
    result = chatbot_service.synthesize_speech(payload.text)
    if not result.get("success"):
        raise HTTPException(status_code=503, detail="Speech synthesis is temporarily unavailable.")
    return Response(content=result["audio"], media_type=result["content_type"])


@router.post("/speak/stream")
async def speak_stream(payload: SpeakRequest, aura_id: str = Depends(resolve_aura_id)):
    """Streaming text-to-speech with per-character timing, via ElevenLabs.

    Returns newline-delimited JSON - each line is one chunk as ElevenLabs
    generates it: {"audio_base64": "...", "alignment": {...}}. The client
    starts playback on the first line rather than waiting for the whole
    sentence, and uses `alignment` to highlight words against real audio
    timing instead of a guessed one.

    If ElevenLabs isn't configured or the call fails, the body streams zero
    lines (200 status, empty NDJSON) rather than erroring - the client is
    expected to detect "no audio arrived" and fall back to POST /speak
    (Groq, non-streaming, no word timing) exactly as the fallback contract
    in elevenlabs_tts.synthesize_stream_with_timestamps promises."""
    if _rate_limited(aura_id):
        raise HTTPException(status_code=429, detail="Please wait a moment before retrying.")

    def generate():
        t_start = time.perf_counter()
        first_chunk_logged = False
        for chunk in elevenlabs_tts.synthesize_stream_with_timestamps(payload.text):
            if not first_chunk_logged:
                logger.info(
                    "latency tts_stream first_audio_chunk_ms=%.0f", (time.perf_counter() - t_start) * 1000
                )
                first_chunk_logged = True
            yield json.dumps(chunk) + "\n"

    return StreamingResponse(
        generate(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
