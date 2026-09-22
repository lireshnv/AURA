"""Context-aware sentiment classification for transcript text.

WHY THIS EXISTS SEPARATELY FROM text_emotion
--------------------------------------------
Text sentiment used to be derived from the emotion classifier's output by
mapping emotions onto positive/neutral/negative. That mapping is fine for a
FACE (you cannot read negation off an expression), but for text it failed on
exactly the cases that matter, because the emotion model keys on the emotion
word and largely ignores the negation around it:

    "I am not angry."              -> angry 96%   -> negative 88%   WRONG
    "I am not sad at all."         -> sad 98%     -> negative 79%   WRONG
    "I don't feel hopeless anymore"-> sad 98%     -> negative 79%   WRONG
    "It was not a bad day."        -> sad 58%     -> negative 60%   WRONG

A dedicated sentiment model trained on sentence-level sentiment handles the
negation properly. Measured on the same inputs:

    "I am not sad at all."          -> positive 56%   correct
    "It was not a bad day."         -> positive 69%   correct
    "I don't feel hopeless anymore" -> neutral        correct
    "I am angry."                   -> negative 82%   still correct
    "I feel hopeless."              -> negative 85%   still correct

Emotion and sentiment are now genuinely separate signals rather than one
derived from the other, which is also what lets them disagree informatively.

This is NOT keyword counting and contains no word lists. It is a transformer
that reads the whole sentence.
"""
import logging
import threading
from dataclasses import dataclass, field
from typing import Dict, List, Optional

logger = logging.getLogger("aura.sentiment_model")

try:
    from transformers import AutoModelForSequenceClassification, AutoTokenizer
    import torch

    _AVAILABLE = True
except ImportError:  # noqa: BLE001
    _AVAILABLE = False

MODEL_ID = "cardiffnlp/twitter-roberta-base-sentiment-latest"
MAX_LOAD_ATTEMPTS = 3

# Sentences shorter than this carry too little context to score confidently.
MIN_WORDS_FOR_CONFIDENCE = 3


@dataclass
class SentimentResult:
    dominant: str = "neutral"
    scores: Dict[str, float] = field(default_factory=dict)
    confidence: float = 0.0
    per_sentence: List[Dict] = field(default_factory=list)
    available: bool = False
    error: Optional[str] = None
    model: str = MODEL_ID


_model = None
_tokenizer = None
_lock = threading.Lock()
_load_error: Optional[str] = None
_attempts = 0


def is_available() -> bool:
    return _AVAILABLE


def _get_model():
    global _model, _tokenizer, _load_error, _attempts
    if _model is not None:
        return _model, _tokenizer
    if _attempts >= MAX_LOAD_ATTEMPTS:
        return None, None
    with _lock:
        if _model is not None:
            return _model, _tokenizer
        if _attempts >= MAX_LOAD_ATTEMPTS:
            return None, None
        _attempts += 1
        try:
            logger.info("Loading sentiment model %s (attempt %d)", MODEL_ID, _attempts)
            _tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
            _model = AutoModelForSequenceClassification.from_pretrained(MODEL_ID)
            _model.eval()
            _load_error = None
            logger.info("Sentiment model ready")
        except Exception as exc:  # noqa: BLE001
            _load_error = str(exc)
            logger.warning("Sentiment model load failed (%d/%d): %s",
                           _attempts, MAX_LOAD_ATTEMPTS, exc)
    return _model, _tokenizer


def load_eagerly() -> None:
    if _AVAILABLE:
        _get_model()


def _split_sentences(text: str) -> List[str]:
    """Lightweight sentence segmentation.

    Deliberately simple: a full NLP sentence splitter is not worth another
    dependency here, and the model tolerates imperfect boundaries.
    """
    import re

    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    return [p.strip() for p in parts if p.strip()]


def _classify(text: str, model, tokenizer) -> Dict[str, float]:
    inputs = tokenizer(text, return_tensors="pt", truncation=True, max_length=256)
    with torch.no_grad():
        probs = torch.softmax(model(**inputs).logits[0], dim=-1).tolist()
    id2label = model.config.id2label
    scores = {"positive": 0.0, "neutral": 0.0, "negative": 0.0}
    for idx, prob in enumerate(probs):
        label = str(id2label[idx]).lower()
        if label in scores:
            scores[label] += prob * 100
    return scores


def analyze(text: str) -> SentimentResult:
    """Sentence-level sentiment, aggregated across the passage.

    Aggregating per sentence rather than scoring one long blob means a single
    negative sentence in an otherwise neutral passage does not dominate, and
    each sentence's own negation is handled in its own context.
    """
    cleaned = (text or "").strip()
    if not cleaned:
        return SentimentResult(available=False, error="No text to analyse.")

    if not _AVAILABLE:
        return SentimentResult(
            available=False,
            error="transformers/torch not installed; sentiment is unavailable.",
        )

    model, tokenizer = _get_model()
    if model is None:
        return SentimentResult(
            available=False, error=f"Sentiment model could not be loaded: {_load_error}"
        )

    try:
        sentences = _split_sentences(cleaned) or [cleaned]
        per_sentence: List[Dict] = []
        totals = {"positive": 0.0, "neutral": 0.0, "negative": 0.0}

        for sentence in sentences:
            scores = _classify(sentence, model, tokenizer)
            dominant = max(scores, key=scores.get)
            per_sentence.append(
                {
                    "text": sentence,
                    "dominant": dominant,
                    "scores": {k: round(v, 1) for k, v in scores.items()},
                }
            )
            for k, v in scores.items():
                totals[k] += v

        count = len(per_sentence) or 1
        aggregated = {k: round(v / count, 1) for k, v in totals.items()}
        dominant = max(aggregated, key=aggregated.get)

        # Confidence reflects both the margin between the top two classes and
        # whether there was enough text to judge. A three-word fragment scoring
        # 60% negative is far weaker evidence than a paragraph doing the same.
        ordered = sorted(aggregated.values(), reverse=True)
        margin = ordered[0] - (ordered[1] if len(ordered) > 1 else 0.0)
        word_count = len(cleaned.split())
        length_factor = min(1.0, word_count / (MIN_WORDS_FOR_CONFIDENCE * 3))
        confidence = round(min(100.0, (aggregated[dominant] * 0.6 + margin * 0.4) * length_factor), 1)

        return SentimentResult(
            dominant=dominant,
            scores=aggregated,
            confidence=confidence,
            per_sentence=per_sentence,
            available=True,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Sentiment analysis failed")
        return SentimentResult(available=False, error=f"Sentiment analysis failed: {exc}")
