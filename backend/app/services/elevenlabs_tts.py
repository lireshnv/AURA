"""Text-to-speech via the ElevenLabs API, for the AURA IVRS call simulation.

Deliberately separate from `chatbot_service.synthesize_speech` (which uses
Groq/PlayAI for the AI Companion's voice) - the IVRS call spec calls for
ElevenLabs specifically as AURA's phone voice. Reuses the same
ELEVENLABS_API_KEY already required for speech-to-text elsewhere in the app.

Never fabricates audio: a missing key, network failure, or API error returns
`available=False` with a reason, and the caller falls back to text-only.
"""
import logging
import os
from dataclasses import dataclass
from typing import Optional

import requests

logger = logging.getLogger("aura.elevenlabs_tts")

ELEVENLABS_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
# "Rachel" - one of ElevenLabs' standard public sample voices. Overridable via
# env so a real deployment can pick a voice from its own account instead.
DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"
TIMEOUT_SECONDS = 30
MAX_CHARS = 2000


@dataclass
class SpeechResult:
    available: bool
    audio: Optional[bytes] = None
    content_type: str = "audio/mpeg"
    error: Optional[str] = None


def _api_key() -> str:
    return os.environ.get("ELEVENLABS_API_KEY", "").strip()


def _voice_id() -> str:
    return os.environ.get("ELEVENLABS_VOICE_ID", "").strip() or DEFAULT_VOICE_ID


def is_configured() -> bool:
    return bool(_api_key())


def synthesize(text: str) -> SpeechResult:
    """Converts the EXACT text given into speech. Never rewrites or
    summarizes the text - Groq owns the words, this only voices them."""
    clean = (text or "").strip()
    if not clean:
        return SpeechResult(available=False, error="empty_text")

    api_key = _api_key()
    if not api_key:
        return SpeechResult(available=False, error="elevenlabs_api_key_missing")

    try:
        response = requests.post(
            ELEVENLABS_TTS_URL.format(voice_id=_voice_id()),
            headers={
                "xi-api-key": api_key,
                "Content-Type": "application/json",
                "Accept": "audio/mpeg",
            },
            json={
                "text": clean[:MAX_CHARS],
                "model_id": "eleven_turbo_v2_5",
                "voice_settings": {"stability": 0.5, "similarity_boost": 0.75},
            },
            timeout=TIMEOUT_SECONDS,
        )
    except requests.RequestException as exc:
        logger.warning("ElevenLabs TTS request failed: %s", exc)
        return SpeechResult(available=False, error=f"tts_request_failed: {exc}")

    if response.status_code != 200:
        logger.warning("ElevenLabs TTS returned %s: %s", response.status_code, response.text[:300])
        return SpeechResult(available=False, error=f"tts_http_{response.status_code}")

    return SpeechResult(available=True, audio=response.content)
