"""Text-to-speech via the ElevenLabs API, for the AURA IVRS call simulation.

Deliberately separate from `chatbot_service.synthesize_speech` (which uses
Groq/PlayAI for the AI Companion's voice) - the IVRS call spec calls for
ElevenLabs specifically as AURA's phone voice. Reuses the same
ELEVENLABS_API_KEY already required for speech-to-text elsewhere in the app.

Never fabricates audio: a missing key, network failure, or API error returns
`available=False` with a reason, and the caller falls back to text-only.
"""
import json
import logging
import os
from dataclasses import dataclass
from typing import Dict, Iterator, Optional

import requests

logger = logging.getLogger("aura.elevenlabs_tts")

ELEVENLABS_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
# Streams audio progressively (so playback can start before the whole
# sentence has synthesized) interleaved with per-character timing, so the
# caller can highlight words against real audio timing instead of a guess.
ELEVENLABS_STREAM_TIMESTAMPS_URL = (
    "https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream/with-timestamps"
)
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


def synthesize_stream_with_timestamps(text: str) -> Iterator[Dict]:
    """Streams TTS for the EXACT text given as it's generated, interleaved
    with per-character timing, for low-latency playback plus real word-level
    highlighting (no fake fixed-timer sync).

    Yields one dict per NDJSON line ElevenLabs sends, shaped like:
      {"audio_base64": "...", "alignment": {"characters": [...],
       "character_start_times_seconds": [...], "character_end_times_seconds": [...]}}

    Requests raw 16kHz PCM (`output_format=pcm_16000`) rather than the
    default MP3 - the browser schedules decoded PCM samples directly via the
    Web Audio API as each chunk arrives, with no container/codec framing to
    worry about at a chunk boundary (which a partial MP3 frame would risk).
    PCM output requires a paid ElevenLabs tier; if the account doesn't have
    one, ElevenLabs returns a non-200 here, which - like every other failure
    path below - degrades to an empty stream.

    Yields nothing on any failure (missing key, network error, non-200,
    malformed line) - the caller must treat an empty stream as "fall back to
    synthesize()", the same available=False contract as the rest of this
    module, just expressed as absence of output instead of a flag."""
    clean = (text or "").strip()
    if not clean:
        return

    api_key = _api_key()
    if not api_key:
        return

    try:
        response = requests.post(
            ELEVENLABS_STREAM_TIMESTAMPS_URL.format(voice_id=_voice_id()),
            params={"output_format": "pcm_16000"},
            headers={
                "xi-api-key": api_key,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            json={
                "text": clean[:MAX_CHARS],
                "model_id": "eleven_turbo_v2_5",
                "voice_settings": {"stability": 0.5, "similarity_boost": 0.75},
            },
            stream=True,
            timeout=TIMEOUT_SECONDS,
        )
    except requests.RequestException as exc:
        logger.warning("ElevenLabs streaming TTS request failed: %s", exc)
        return

    if response.status_code != 200:
        logger.warning(
            "ElevenLabs streaming TTS returned %s: %s", response.status_code, response.text[:300]
        )
        return

    try:
        for line in response.iter_lines():
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                logger.debug("Skipping malformed ElevenLabs stream line")
                continue
    except requests.RequestException as exc:
        logger.warning("ElevenLabs streaming TTS interrupted: %s", exc)
        return
