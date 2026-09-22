"""Emotion analysis of the transcript text, independent of voice tone.

This is deliberately a separate signal from voice_emotion.py. Someone can say
"I'm fine" (text: neutral) in a flat, low-energy voice (voice: sad) - and the
multimodal layer is expected to surface that disagreement rather than smooth
it away. Merging the two would destroy exactly the information that makes the
disagreement detectable.

The model is a pretrained DistilRoBERTa emotion classifier whose label set is
already the seven Ekman emotions AURA uses, so the mapping is 1:1 and lossless
rather than an approximate remap of an unrelated taxonomy.

No keyword or word-list fallback is provided. A hand-written keyword matcher
would look like a working emotion model while actually being arbitrary, so
when the model is unavailable this module reports that plainly instead.
"""
import logging
import threading
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from . import config
from .sentiment import compute_sentiment
from .services import sentiment_model

logger = logging.getLogger("aura.text")

try:
    from transformers import AutoModelForSequenceClassification, AutoTokenizer
    import torch

    _TRANSFORMERS_OK = True
except Exception:  # noqa: BLE001
    _TRANSFORMERS_OK = False


# This model's labels -> AURA's seven. A genuine 1:1 correspondence.
LABEL_MAP = {
    "anger": "angry",
    "disgust": "disgust",
    "fear": "fear",
    "joy": "happy",
    "neutral": "neutral",
    "sadness": "sad",
    "surprise": "surprise",
}


@dataclass
class TextEmotionResult:
    dominant: str = "neutral"
    scores: Dict[str, float] = field(default_factory=dict)
    confidence: float = 0.0
    sentiment_dominant: str = "neutral"
    sentiment_scores: Dict[str, float] = field(default_factory=dict)
    language_supported: bool = True
    evidence: List[str] = field(default_factory=list)
    available: bool = False
    error: Optional[str] = None


_model = None
_tokenizer = None
_model_lock = threading.Lock()
_load_error: Optional[str] = None
_load_attempts = 0

# Weights download on first load, so a transient network failure is retried
# across requests instead of disabling text emotion until a restart.
MAX_LOAD_ATTEMPTS = 3


def is_available() -> bool:
    return _TRANSFORMERS_OK


def _get_model():
    global _model, _tokenizer, _load_error, _load_attempts
    if _model is not None:
        return _model, _tokenizer
    if _load_attempts >= MAX_LOAD_ATTEMPTS:
        return None, None
    with _model_lock:
        if _model is not None:
            return _model, _tokenizer
        if _load_attempts >= MAX_LOAD_ATTEMPTS:
            return None, None
        _load_attempts += 1
        try:
            logger.info("Loading text emotion model '%s'", config.TEXT_EMOTION_MODEL)
            _tokenizer = AutoTokenizer.from_pretrained(config.TEXT_EMOTION_MODEL)
            _model = AutoModelForSequenceClassification.from_pretrained(
                config.TEXT_EMOTION_MODEL
            )
            _model.eval()
            _load_error = None
            logger.info("Text emotion model ready")
        except Exception as exc:  # noqa: BLE001
            _load_error = str(exc)
            logger.warning(
                "Text emotion load attempt %d/%d failed: %s",
                _load_attempts,
                MAX_LOAD_ATTEMPTS,
                exc,
            )
    return _model, _tokenizer


def load_eagerly() -> None:
    if _TRANSFORMERS_OK:
        _get_model()


def _describe_evidence(text: str, scores: Dict[str, float], dominant: str) -> List[str]:
    """Evidence strictly derived from the model output and the actual text.

    Nothing is asserted about *why* the model decided what it decided beyond
    what is observable: the winning label, its margin, and measurable
    properties of the input. No invented narrative about the speaker.
    """
    evidence: List[str] = []
    words = text.split()

    top = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    if top:
        evidence.append(f"Model assigned '{top[0][0]}' the highest probability ({top[0][1]:.0f}%).")
    if len(top) > 1:
        margin = top[0][1] - top[1][1]
        if margin < 15:
            evidence.append(
                f"Close between '{top[0][0]}' and '{top[1][0]}' "
                f"({margin:.0f} point margin) - text signal is not clear-cut."
            )
    if len(words) < 4:
        evidence.append(
            f"Only {len(words)} word(s) of transcript - limited basis for a text emotion estimate."
        )
    if dominant == "neutral":
        evidence.append("Spoken content carried no strong emotional wording.")
    return evidence


def analyze_text(text: str, language: Optional[str] = None) -> TextEmotionResult:
    """Classifies transcript text into AURA's seven emotions plus sentiment."""
    cleaned = (text or "").strip()
    if not cleaned:
        return TextEmotionResult(
            available=False, error="No transcript text to analyse."
        )

    if not _TRANSFORMERS_OK:
        return TextEmotionResult(
            available=False,
            error=(
                "transformers/torch not installed; text emotion is unavailable. "
                "No keyword fallback is used, as it would not be a real model."
            ),
        )

    model, tokenizer = _get_model()
    if model is None:
        return TextEmotionResult(
            available=False, error=f"Text emotion model could not be loaded: {_load_error}"
        )

    # The model is English-only. Report that honestly rather than running it on
    # a language it was not trained for and presenting the output as valid.
    language_supported = language is None or language in config.TEXT_EMOTION_LANGUAGES

    try:
        inputs = tokenizer(
            cleaned, return_tensors="pt", truncation=True, max_length=256
        )
        with torch.no_grad():
            logits = model(**inputs).logits[0]
        probs = torch.softmax(logits, dim=-1).tolist()

        id2label = model.config.id2label
        scores: Dict[str, float] = {k: 0.0 for k in config.EMOTION_KEYS}
        for idx, prob in enumerate(probs):
            raw_label = str(id2label[idx]).lower()
            mapped = LABEL_MAP.get(raw_label)
            if mapped is None:
                logger.warning("Unmapped text-emotion label '%s' ignored", raw_label)
                continue
            scores[mapped] += prob * 100

        total = sum(scores.values())
        if total > 0:
            scores = {k: round(v / total * 100, 1) for k, v in scores.items()}

        dominant = max(scores, key=scores.get)
        confidence = round(scores[dominant], 1)

        # Sentiment comes from a DEDICATED context-aware model, not from
        # mapping this emotion distribution. The emotion classifier keys on
        # the emotion word and misses negation - "I am not angry" scored
        # angry 96% -> negative 88%. See services/sentiment_model.py.
        # The emotion->sentiment mapping is retained only as a fallback for
        # when that model is unavailable, so sentiment never simply vanishes.
        sentiment = sentiment_model.analyze(cleaned)
        if sentiment.available:
            sentiment_dominant = sentiment.dominant
            sentiment_scores = sentiment.scores
        else:
            logger.info("Dedicated sentiment unavailable (%s); using emotion mapping",
                        sentiment.error)
            sentiment_dominant, sentiment_scores = compute_sentiment(scores)

        result = TextEmotionResult(
            dominant=dominant,
            scores=scores,
            confidence=confidence,
            sentiment_dominant=sentiment_dominant,
            sentiment_scores=sentiment_scores,
            language_supported=language_supported,
            evidence=_describe_evidence(cleaned, scores, dominant),
            available=True,
        )
        if not language_supported:
            result.evidence.insert(
                0,
                f"Transcript language '{language}' is outside this model's supported "
                f"set {config.TEXT_EMOTION_LANGUAGES}; treat the text emotion as unreliable.",
            )
        return result
    except Exception as exc:  # noqa: BLE001
        logger.exception("Text emotion analysis failed")
        return TextEmotionResult(available=False, error=f"Text analysis failed: {exc}")
