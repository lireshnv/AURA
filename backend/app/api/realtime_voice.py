"""AURA realtime (full-duplex) voice - BETA, free-tier Gemini Live only.

    Browser <--WS--> AURA FastAPI <--WS--> Gemini Live

The browser never sees GEMINI_API_KEY, same rule as the Groq path in chat.py.
Kept as an explicit additive/beta path, not the primary voice route: see the
free-tier privacy caveat in services/gemini_live.py's module docstring.

SAFETY GATE: Gemini streams a complete transcript of what the user said
(serverContent.inputTranscription) BEFORE its own reply audio starts
streaming (confirmed empirically - see gemini_live.py). This relay runs the
same deterministic crisis check every other Aura surface uses
(chat_safety.check_message) against that transcript the instant it arrives,
and if it fires, stops forwarding any further reply audio for that turn to
the browser. This is a guaranteed-correct mute on OUR side of the relay - it
does not depend on Gemini's own cancellation working, though Gemini appears
to cancel its own generation on interruption too (confirmed empirically).

TURN BOOKKEEPING: Gemini's protocol has no explicit per-turn response id -
this relay mints its own `turn_id`, reset whenever Gemini reports the
generation was interrupted or completed, purely so the browser can
distinguish which UI state a given server event belongs to.
"""
import asyncio
import base64
import json
import logging
import time
import uuid
from typing import Dict, Optional

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool

from ..security.auth import decode_token
from ..services import chat_safety, chatbot_service, gemini_live
from . import chat as chat_api

logger = logging.getLogger("aura.realtime_voice")
router = APIRouter(prefix="/api/realtime-voice", tags=["realtime-voice"])


def _resolve_aura_id_ws(token: Optional[str]) -> str:
    """Same fallback behaviour as chat.py's resolve_aura_id, adapted for a
    WebSocket query param instead of an Authorization header (browsers
    cannot set custom headers on a WS handshake)."""
    if not token:
        return "local-user"
    try:
        payload = decode_token(token)
        if payload and payload.get("aura_id"):
            return str(payload["aura_id"])
    except Exception:  # noqa: BLE001 - auth is optional in the prototype
        logger.debug("Token could not be decoded for realtime voice; using local identity")
    return "local-user"


class _RelayState:
    """Per-connection turn bookkeeping. Reset points are called out on each
    field so it's clear when a stale value could leak into a new turn."""

    def __init__(self) -> None:
        self.turn_id = str(uuid.uuid4())
        # Reset to "" on interrupted/generationComplete - a fresh turn starts
        # with no memory of the previous one's text.
        self.input_transcript = ""
        self.output_transcript = ""
        # Reset to False on interrupted/generationComplete.
        self.output_muted = False
        self.safety_fired_this_turn = False
        self.t_connect = time.perf_counter()
        self.first_input_transcript_logged = False
        self.first_audio_relayed_logged = False

    def new_turn(self) -> None:
        self.turn_id = str(uuid.uuid4())
        self.input_transcript = ""
        self.output_transcript = ""
        self.output_muted = False
        self.safety_fired_this_turn = False
        self.first_input_transcript_logged = False
        self.first_audio_relayed_logged = False


async def _handle_tool_call(gemini_ws, tool_call: Dict) -> None:
    for fc in tool_call.get("functionCalls", []):
        name = fc.get("name")
        call_id = fc.get("id", "")
        if name == "search_web":
            query = (fc.get("args") or {}).get("query", "")
            result = await run_in_threadpool(chatbot_service.perform_web_search, query)
        else:
            result = "This tool is not available."
        await gemini_ws.send(gemini_live.tool_response(call_id, name or "", result))


def _append_completed_turn(aura_id: str, session_id: str, state: _RelayState) -> None:
    user_text = state.input_transcript.strip()
    assistant_text = state.output_transcript.strip()
    if not user_text and not assistant_text:
        return
    key = (aura_id, session_id)
    with chat_api._conversation_lock:
        convo = chat_api._conversations[key]
        if user_text:
            convo.append({"role": "user", "content": user_text})
        if assistant_text:
            convo.append({"role": "assistant", "content": assistant_text})


async def _pump_browser_to_gemini(websocket: WebSocket, gemini_ws, state: _RelayState) -> None:
    """Continuous mic audio (binary frames) -> Gemini. A JSON text frame is a
    control message from the browser (currently only {"type":"end"})."""
    while True:
        message = await websocket.receive()
        if message["type"] == "websocket.disconnect":
            return
        data = message.get("bytes")
        if data:
            await gemini_ws.send(gemini_live.realtime_input_audio_chunk(data))
            continue
        text = message.get("text")
        if text:
            try:
                ctrl = json.loads(text)
            except json.JSONDecodeError:
                continue
            if ctrl.get("type") == "end":
                return


async def _pump_gemini_to_browser(
    websocket: WebSocket, gemini_ws, state: _RelayState, aura_id: str, session_id: str
) -> None:
    async for msg in gemini_live.iter_messages(gemini_ws):
        if "toolCall" in msg:
            await _handle_tool_call(gemini_ws, msg["toolCall"])
            continue

        sc = msg.get("serverContent")
        if not sc:
            continue

        if "inputTranscription" in sc:
            text = (sc["inputTranscription"] or {}).get("text", "")
            if text:
                state.input_transcript = text  # confirmed: full text each message, not a delta
                if not state.first_input_transcript_logged:
                    state.first_input_transcript_logged = True
                    logger.info(
                        "latency realtime_voice turn=%s first_input_transcript_ms=%.0f",
                        state.turn_id,
                        (time.perf_counter() - state.t_connect) * 1000,
                    )
                if not state.safety_fired_this_turn:
                    safety = chat_safety.check_message(text)
                    if safety.triggered:
                        state.safety_fired_this_turn = True
                        state.output_muted = True
                        await websocket.send_json(
                            {
                                "type": "safety",
                                "turn_id": state.turn_id,
                                "severity": safety.severity,
                                "message": safety.message,
                                "resources": safety.resources,
                            }
                        )

        if "outputTranscription" in sc:
            delta = (sc["outputTranscription"] or {}).get("text", "")
            if delta:
                state.output_transcript += delta
                await websocket.send_json(
                    {"type": "output_transcript_delta", "text": delta, "turn_id": state.turn_id}
                )

        if "modelTurn" in sc:
            for part in sc["modelTurn"].get("parts", []):
                inline = part.get("inlineData")
                if not inline or not inline.get("data"):
                    continue
                if state.output_muted:
                    continue  # safety gate: consumed off the socket, never sent to the browser
                if not state.first_audio_relayed_logged:
                    state.first_audio_relayed_logged = True
                    logger.info(
                        "latency realtime_voice turn=%s first_audio_relayed_ms=%.0f",
                        state.turn_id,
                        (time.perf_counter() - state.t_connect) * 1000,
                    )
                await websocket.send_bytes(base64.b64decode(inline["data"]))

        if sc.get("interrupted"):
            await websocket.send_json({"type": "interrupted", "turn_id": state.turn_id})
            _append_completed_turn(aura_id, session_id, state)
            state.new_turn()

        if sc.get("generationComplete") or sc.get("turnComplete"):
            await websocket.send_json({"type": "turn_complete", "turn_id": state.turn_id})
            _append_completed_turn(aura_id, session_id, state)
            state.new_turn()


@router.get("/status")
async def realtime_voice_status():
    """Honest capability report - mirrors chatbot_service.capability_report().
    "ready" means "configured", not "verified reachable right now"; a real
    connection attempt (the WS route below) is the authoritative check."""
    return {"success": True, **gemini_live.capability_report()}


@router.websocket("/ws")
async def realtime_voice_ws(
    websocket: WebSocket,
    token: Optional[str] = Query(default=None),
    session_id: Optional[str] = Query(default=None),
    language: Optional[str] = Query(default=None),
):
    aura_id = _resolve_aura_id_ws(token)
    session_id = session_id or str(uuid.uuid4())

    await websocket.accept()

    if not gemini_live.is_configured():
        await websocket.send_json({"type": "unavailable", "reason": "not_configured"})
        await websocket.close()
        return

    system_instruction = chatbot_service.get_system_prompt(language=language, voice_mode=True)
    try:
        gemini_ws = await gemini_live.connect(system_instruction)
    except gemini_live.GeminiSetupError as exc:
        logger.warning("Realtime voice: Gemini setup failed for %s: %s", aura_id, exc)
        await websocket.send_json({"type": "unavailable", "reason": "gemini_setup_failed"})
        await websocket.close()
        return

    await websocket.send_json({"type": "ready", "session_id": session_id})
    logger.info("Realtime voice session started: aura_id=%s session_id=%s", aura_id, session_id)

    state = _RelayState()
    try:
        browser_task = asyncio.create_task(_pump_browser_to_gemini(websocket, gemini_ws, state))
        gemini_task = asyncio.create_task(
            _pump_gemini_to_browser(websocket, gemini_ws, state, aura_id, session_id)
        )
        done, pending = await asyncio.wait(
            {browser_task, gemini_task}, return_when=asyncio.FIRST_COMPLETED
        )
        for task in pending:
            task.cancel()
        for task in done:
            exc = task.exception() if not task.cancelled() else None
            if exc and not isinstance(exc, WebSocketDisconnect):
                logger.warning("Realtime voice relay task ended with error: %s", exc)
    finally:
        _append_completed_turn(aura_id, session_id, state)
        try:
            await gemini_ws.close()
        except Exception:  # noqa: BLE001
            pass
        logger.info("Realtime voice session ended: aura_id=%s session_id=%s", aura_id, session_id)
