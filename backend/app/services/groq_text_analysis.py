"""Groq-backed structured analysis of a settled voice transcript.

This is deliberately separate from `text_emotion.py` / `sentiment_model.py`
(the local HF models that score every transcript window for fusion). Those
stay authoritative for the numeric emotion/sentiment fed into distress
scoring - Groq is never allowed to invent that final percentage. This module
instead asks Groq for the qualitative layer a local classifier can't produce:
key concerns, themes, a supportive reply, and practical next steps - grounded
strictly in the words actually transcribed.

Reuses the same Groq client/model plumbing as the chat companion
(`chatbot_service.py`) rather than standing up a second client/config.
"""
import json
import logging
import os
from typing import Dict, Optional

from . import chatbot_service
from ..config import EMOTION_KEYS

logger = logging.getLogger("aura.groq_text_analysis")

ANALYSIS_MODEL = os.environ.get("AURA_TEXT_ANALYSIS_MODEL", chatbot_service.MODEL)

# Minimum words before a transcript is worth a Groq call at all - a couple of
# stray words ("okay", "yeah") is not a "validated/stable" transcript segment
# and would just waste a request on noise.
MIN_WORDS = 4

SYSTEM_PROMPT = f"""You analyze a short transcript of something a person said out loud, as part of a supportive wellbeing companion.

Return ONLY a JSON object with exactly these fields:
- "sentiment": one of "positive", "neutral", "negative"
- "emotion": one of {EMOTION_KEYS}
- "confidence": a number from 0 to 100 - how clearly the transcript supports your sentiment/emotion call
- "key_concerns": a short list of concerns literally stated or clearly implied by the transcript (empty list if none)
- "themes": a short list of topic themes present in the transcript (empty list if none)
- "supportive_response": one or two warm, non-clinical sentences responding to what was actually said
- "practical_suggestions": a short list of concrete, practical next steps relevant to what was said (empty list if none apply)

Rules - these are strict:
1. Base every field ONLY on the transcript given. Never invent symptoms, events, people, history, or distress the person did not actually state.
2. If the transcript is too short, vague, or neutral to support a field, use an empty list (for lists) or "neutral"/low confidence rather than guessing.
3. Do not diagnose, and do not claim to be a clinician.
4. Output valid JSON only, no prose outside the JSON object."""


def is_configured() -> bool:
    return chatbot_service.is_configured()


def _word_count(text: str) -> int:
    return len(text.split())


def analyze_transcript(transcript: str) -> Dict:
    """Runs Groq's structured read of one settled transcript segment.

    Never fabricates: returns `available: False` with a reason when Groq
    isn't configured, or when the transcript is too thin to analyze - it does
    not fall back to a fake/neutral analysis in either case.
    """
    text = (transcript or "").strip()
    if not text:
        return {"available": False, "reason": "empty_transcript"}
    if _word_count(text) < MIN_WORDS:
        return {"available": False, "reason": "transcript_too_short"}

    if not chatbot_service.is_configured():
        return {"available": False, "reason": "groq_not_configured"}

    try:
        client = chatbot_service.get_client()
    except RuntimeError as exc:
        return {"available": False, "reason": str(exc)}

    try:
        response = client.chat.completions.create(
            model=ANALYSIS_MODEL,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": text},
            ],
            response_format={"type": "json_object"},
            max_tokens=600,
            temperature=0.2,
        )
        raw = response.choices[0].message.content or "{}"
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("Groq transcript analysis returned non-JSON content")
        return {"available": False, "reason": "invalid_model_output"}
    except Exception:  # noqa: BLE001 - a bad analysis call must not break the caller
        logger.exception("Groq transcript analysis failed")
        return {"available": False, "reason": "request_failed"}

    sentiment = str(parsed.get("sentiment") or "neutral").lower()
    if sentiment not in {"positive", "neutral", "negative"}:
        sentiment = "neutral"

    emotion = str(parsed.get("emotion") or "neutral").lower()
    if emotion not in EMOTION_KEYS:
        emotion = "neutral"

    try:
        confidence = float(parsed.get("confidence", 0))
    except (TypeError, ValueError):
        confidence = 0.0
    confidence = max(0.0, min(100.0, confidence))

    def _str_list(value: Optional[list]) -> list:
        if not isinstance(value, list):
            return []
        return [str(v) for v in value if str(v).strip()]

    return {
        "available": True,
        "sentiment": sentiment,
        "emotion": emotion,
        "confidence": round(confidence, 1),
        "key_concerns": _str_list(parsed.get("key_concerns")),
        "themes": _str_list(parsed.get("themes")),
        "supportive_response": str(parsed.get("supportive_response") or "").strip(),
        "practical_suggestions": _str_list(parsed.get("practical_suggestions")),
        "model": ANALYSIS_MODEL,
        "grounded_in_transcript": True,
    }
