"""Speech-to-text via the ElevenLabs Speech-to-Text API.

The API key is read from the environment (ELEVENLABS_API_KEY) lazily, on each
call, rather than cached at import time - by the time a request actually
reaches this module the app has finished starting up and `.env` has already
been loaded by `app.core.config`, but caching a decision made at import time
would risk freezing in a false "unavailable" if that ordering ever changes.

Nothing here fabricates a transcript. A missing key, a network failure, or an
API error all return `available=False` with a reason, which callers surface
as "unavailable" - never as silence or an invented empty result.
"""
import io
import logging
import os
from dataclasses import dataclass, field
from typing import Dict, List, Optional

import numpy as np
import requests

from . import config

logger = logging.getLogger("aura.stt")

try:
    import soundfile as sf

    _SOUNDFILE_OK = True
except Exception:  # noqa: BLE001
    _SOUNDFILE_OK = False

ELEVENLABS_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text"


@dataclass
class Transcription:
    text: str = ""
    language: Optional[str] = None
    language_probability: Optional[float] = None
    segments: List[Dict] = field(default_factory=list)
    # Mean of ElevenLabs' per-word `logprob` (a log-probability, not a
    # calibrated confidence) across recognized words in this window. Surfaced
    # as-is and only ever converted to a coarse 0-1 indicator downstream.
    mean_logprob: Optional[float] = None
    available: bool = True
    error: Optional[str] = None


def _api_key() -> str:
    return os.environ.get("ELEVENLABS_API_KEY", "").strip()


def is_available() -> bool:
    return _SOUNDFILE_OK and bool(_api_key())


def load_eagerly() -> None:
    """Called at startup. There is no local model to preload for a hosted
    API - this only logs whether the integration is actually usable, so a
    missing key is visible in the startup log instead of only surfacing on
    the first user request."""
    if not _SOUNDFILE_OK:
        logger.warning("soundfile is not installed; speech-to-text cannot encode audio.")
    elif not _api_key():
        logger.warning(
            "ELEVENLABS_API_KEY is not set; speech-to-text is unavailable until it is."
        )
    else:
        logger.info("ElevenLabs speech-to-text configured (model '%s').", config.ELEVENLABS_STT_MODEL)


def _encode_wav(samples: np.ndarray) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, samples, samplerate=config.STT_SAMPLE_RATE, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def transcribe(
    samples: np.ndarray,
    language: Optional[str] = None,
    beam_size: Optional[int] = None,  # noqa: ARG001 - no beam-search concept in a hosted API; kept so callers need no changes
) -> Transcription:
    """Transcribes 16 kHz mono float32 audio via ElevenLabs Speech-to-Text.

    Returns available=False with a reason when the dependency, key, or
    network call is missing/failing, rather than an empty transcript that
    would look like genuine silence.
    """
    if not _SOUNDFILE_OK:
        return Transcription(
            available=False,
            error="soundfile is not installed; audio cannot be encoded for transcription.",
        )

    api_key = _api_key()
    if not api_key:
        return Transcription(
            available=False,
            error="ELEVENLABS_API_KEY is not set; speech-to-text is unavailable.",
        )

    try:
        wav_bytes = _encode_wav(samples)
    except Exception as exc:  # noqa: BLE001
        logger.exception("WAV encoding failed before ElevenLabs STT request")
        return Transcription(available=False, error=f"Audio encoding failed: {exc}")

    data = {
        "model_id": config.ELEVENLABS_STT_MODEL,
        "timestamps_granularity": "word",
    }
    if language:
        data["language_code"] = language

    try:
        response = requests.post(
            ELEVENLABS_STT_URL,
            headers={"xi-api-key": api_key},
            data=data,
            files={"file": ("audio.wav", wav_bytes, "audio/wav")},
            timeout=config.ELEVENLABS_TIMEOUT_SECONDS,
        )
    except requests.RequestException as exc:
        logger.warning("ElevenLabs STT request failed: %s", exc)
        return Transcription(available=False, error=f"Speech-to-text request failed: {exc}")

    if response.status_code != 200:
        logger.warning("ElevenLabs STT returned %s: %s", response.status_code, response.text[:500])
        return Transcription(
            available=False,
            error=f"Speech-to-text service returned an error (HTTP {response.status_code}).",
        )

    try:
        payload = response.json()
    except ValueError as exc:
        return Transcription(available=False, error=f"Speech-to-text returned an unreadable response: {exc}")

    # ElevenLabs already assembles a punctuated full transcript - joining
    # word tokens ourselves would lose that spacing/punctuation, so it is
    # used directly rather than rebuilt from the word list.
    full_text = (payload.get("text") or "").strip()

    # Segments feed transcript_cleanup's confidence split and
    # audio_features.speech_timing's pause detection, both of which only need
    # {start, end, text, avg_logprob} per entry - so each recognized word
    # becomes its own segment. "spacing" and "audio_event" entries are not
    # words and are skipped.
    segments: List[Dict] = []
    logprobs: List[float] = []
    for word in payload.get("words") or []:
        if word.get("type") != "word":
            continue
        text = (word.get("text") or "").strip()
        if not text:
            continue
        entry = {
            "start": round(float(word.get("start", 0.0)), 2),
            "end": round(float(word.get("end", 0.0)), 2),
            "text": text,
        }
        logprob = word.get("logprob")
        if logprob is not None:
            entry["avg_logprob"] = round(float(logprob), 4)
            logprobs.append(float(logprob))
        segments.append(entry)

    return Transcription(
        text=full_text,
        language=payload.get("language_code"),
        language_probability=(
            round(float(payload["language_probability"]), 3)
            if payload.get("language_probability") is not None
            else None
        ),
        segments=segments,
        mean_logprob=round(sum(logprobs) / len(logprobs), 3) if logprobs else None,
        available=True,
    )


def logprob_to_indicator(mean_logprob: Optional[float]) -> Optional[float]:
    """Maps a mean word `logprob` to a coarse 0-100 quality indicator.

    This is explicitly an INDICATOR, not a transcription accuracy or
    confidence percentage - ElevenLabs does not expose a calibrated
    confidence. Callers surface it labelled as such, and show "unavailable"
    when None.
    """
    if mean_logprob is None:
        return None
    # logprob typically spans about -1.0 (poor) to 0.0 (clean), same range
    # convention as the previous Whisper avg_logprob this replaces.
    return round(float(max(0.0, min(1.0, 1.0 + mean_logprob)) * 100), 1)
