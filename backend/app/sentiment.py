"""Maps a full emotion probability distribution to a positive/neutral/negative split."""
from typing import Dict, Tuple

from . import config


def compute_sentiment(emotion_scores: Dict[str, float]) -> Tuple[str, Dict[str, float]]:
    total = sum(emotion_scores.values()) or 1.0

    positive = 0.0
    neutral = 0.0
    negative = 0.0

    for emotion, score in emotion_scores.items():
        weights = config.SENTIMENT_MAP.get(emotion)
        if not weights:
            continue
        weight_fraction = score / total
        positive += weight_fraction * weights["positive"]
        neutral += weight_fraction * weights["neutral"]
        negative += weight_fraction * weights["negative"]

    raw_total = positive + neutral + negative or 1.0
    positive = round(positive / raw_total * 100, 1)
    neutral = round(neutral / raw_total * 100, 1)
    negative = round(100 - positive - neutral, 1)  # remainder keeps exact 100% sum

    scores = {"positive": positive, "neutral": neutral, "negative": negative}
    dominant = max(scores, key=scores.get)
    return dominant, scores
