"""Gemini Live API protocol client, for Aura's realtime (full-duplex)
voice conversation. Deliberately ignorant of FastAPI, conversation history,
and Aura's prompt content - this module only knows how to speak the Gemini
Live WebSocket protocol. `api/realtime_voice.py` owns the relay/business
logic; this module owns the wire format.

FREE TIER ONLY: this integration is built and tested against the Gemini
Developer API's free tier deliberately, on the user's explicit instruction
to never move this onto a cost basis. Two consequences worth remembering:
  * Free-tier terms let Google use inputs/outputs to improve their models.
    That is not an acceptable default for real abuse disclosures, so the
    realtime voice path this powers must stay an explicit opt-in/beta
    surface, not silently become the primary crisis-conversation route,
    until a deployment decides to enable billing for the no-training
    guarantee.
  * Free-tier availability of preview Live models can be rate-limited or
    revoked without notice - capability_report() below reports only
    "is a key configured", never "verified reachable right now", so a
    live connection attempt is still the authoritative check.

PROTOCOL FACTS CONFIRMED EMPIRICALLY (2026-09-24, against a real key) before
this module was written - see the raw test scripts this was built from:
  * Endpoint is the v1beta bidi endpoint, not v1alpha.
  * Input audio message shape: {"realtimeInput": {"audio": {"data": <base64>,
    "mimeType": "audio/pcm;rate=16000"}}}.
  * The server's own VAD requires CONTINUOUS streaming (including silence)
    to detect end-of-turn - stopping the audio stream entirely, rather than
    continuing with silence, means the server never responds at all. The
    caller must keep streaming mic audio (real or silence) throughout.
  * serverContent.inputTranscription.text arrives as ONE message with the
    complete utterance, promptly after end-of-speech is detected - and
    BEFORE the audio reply starts streaming. This is what makes running the
    deterministic safety check against it, before relaying any reply audio,
    actually work.
  * serverContent.interrupted == true fires when the user starts a new
    utterance while a reply is still streaming; the model's OWN generation
    stops server-side (confirmed: the next utterance's transcript contained
    only the new speech, never a concatenation of both) - our own mute is a
    belt-and-braces guarantee on top of that, not the sole mechanism.
  * Turn-end signal observed was serverContent.generationComplete, not
    turnComplete, on this model/API version.
"""
import base64
import json
import logging
import os
from typing import AsyncIterator, Dict, Optional

logger = logging.getLogger("aura.gemini_live")

try:
    import websockets

    _WEBSOCKETS_AVAILABLE = True
except ImportError:  # noqa: BLE001
    _WEBSOCKETS_AVAILABLE = False

GEMINI_LIVE_URL = (
    "wss://generativelanguage.googleapis.com/ws/"
    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
)
MODEL = os.environ.get("AURA_REALTIME_VOICE_MODEL", "models/gemini-3.8-live")
INPUT_SAMPLE_RATE = 16000
OUTPUT_SAMPLE_RATE = 24000
CONNECT_TIMEOUT_SECONDS = 15
# "Sulafat" is one of Gemini's 30 prebuilt voices, documented tone "Warm" -
# matches the steady/safe-presence persona the system prompt already asks
# for. Confirmed empirically (2026-09-24) that Live API's setup accepts both
# this and generationConfig.temperature.
VOICE_NAME = os.environ.get("AURA_REALTIME_VOICE_NAME", "Sulafat")
# Slightly above Gemini's implicit default, for more varied/less templated
# phrasing - paired with the prompt's own anti-repetition rules, not a
# substitute for them.
TEMPERATURE = float(os.environ.get("AURA_REALTIME_VOICE_TEMPERATURE", "1.1"))

# Gemini Live's function-calling declaration shape (no "type": "function"
# wrapper - that's OpenAI/Groq-specific). Mirrors chatbot_service's
# WEB_SEARCH_TOOL description exactly so behaviour matches the Groq path.
WEB_SEARCH_TOOL = {
    "functionDeclarations": [
        {
            "name": "search_web",
            "description": (
                "Searches the web for information using DuckDuckGo. Use this tool when "
                "the user asks for factual information, NGOs, legal rights, or anything "
                "that requires up-to-date knowledge from the internet."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query to look up on the internet.",
                    }
                },
                "required": ["query"],
            },
        }
    ]
}


class GeminiSetupError(RuntimeError):
    """Raised when the Gemini Live session could not be established, so the
    caller can fall back to the existing Groq/ElevenLabs voice pipeline
    cleanly instead of hanging or crashing the connection."""


def is_configured() -> bool:
    return _WEBSOCKETS_AVAILABLE and bool(os.environ.get("GEMINI_API_KEY", "").strip())


def capability_report() -> Dict:
    """Honest report of what the realtime voice path can currently do -
    same shape/spirit as chatbot_service.capability_report(). "ready" here
    means "configured", not "verified reachable right now"; an actual
    connection attempt is still the authoritative check."""
    configured = is_configured()
    return {
        "websockets_installed": _WEBSOCKETS_AVAILABLE,
        "api_key_configured": bool(os.environ.get("GEMINI_API_KEY", "").strip()),
        "model": MODEL,
        "ready": configured,
        "note": (
            "Set GEMINI_API_KEY in the backend environment to enable realtime voice."
            if not configured
            else "Realtime voice is configured (free tier)."
        ),
    }


def _api_key() -> str:
    return os.environ.get("GEMINI_API_KEY", "").strip()


async def connect(system_instruction: str, enable_web_search: bool = True):
    """Opens a Gemini Live session and completes the setup handshake.
    Raises GeminiSetupError on any failure - never leaves a half-open
    connection for the caller to mishandle."""
    if not _WEBSOCKETS_AVAILABLE:
        raise GeminiSetupError("websockets_not_installed")
    api_key = _api_key()
    if not api_key:
        raise GeminiSetupError("api_key_missing")

    url = f"{GEMINI_LIVE_URL}?key={api_key}"
    try:
        ws = await websockets.connect(url, open_timeout=CONNECT_TIMEOUT_SECONDS, max_size=None)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Gemini Live connection failed: %s", exc)
        raise GeminiSetupError(f"connect_failed: {exc}") from exc

    setup: Dict = {
        "setup": {
            "model": MODEL,
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "temperature": TEMPERATURE,
                "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": VOICE_NAME}}},
            },
            "systemInstruction": {"parts": [{"text": system_instruction}]},
        }
    }
    if enable_web_search:
        setup["setup"]["tools"] = [WEB_SEARCH_TOOL]

    try:
        await ws.send(json.dumps(setup))
        reply = await ws.recv()
        reply_text = reply.decode("utf-8") if isinstance(reply, (bytes, bytearray)) else reply
        parsed = json.loads(reply_text)
        if "setupComplete" not in parsed:
            raise GeminiSetupError(f"unexpected_setup_reply: {reply_text[:200]}")
    except GeminiSetupError:
        await ws.close()
        raise
    except Exception as exc:  # noqa: BLE001
        await ws.close()
        logger.warning("Gemini Live setup handshake failed: %s", exc)
        raise GeminiSetupError(f"setup_failed: {exc}") from exc

    return ws


def realtime_input_audio_chunk(pcm16_bytes: bytes, sample_rate: int = INPUT_SAMPLE_RATE) -> str:
    """Builds one realtimeInput message for a chunk of mic audio (16-bit PCM,
    mono). Returns the JSON string ready to send - callers stream these
    continuously (confirmed requirement, see module docstring)."""
    b64 = base64.b64encode(pcm16_bytes).decode("ascii")
    return json.dumps(
        {"realtimeInput": {"audio": {"data": b64, "mimeType": f"audio/pcm;rate={sample_rate}"}}}
    )


def tool_response(call_id: str, name: str, result: str) -> str:
    """Builds a toolResponse message answering one Gemini functionCall."""
    return json.dumps(
        {
            "toolResponse": {
                "functionResponses": [{"id": call_id, "name": name, "response": {"result": result}}]
            }
        }
    )


async def iter_messages(ws) -> AsyncIterator[Dict]:
    """Yields parsed JSON messages from an open Gemini Live socket. Frames
    may arrive as text or bytes depending on the client library/proxy path;
    both are normalized to dicts here so the relay never has to care."""
    async for raw in ws:
        text = raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else raw
        try:
            yield json.loads(text)
        except json.JSONDecodeError:
            logger.debug("Skipping malformed Gemini Live message")
            continue
