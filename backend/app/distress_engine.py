"""Session-level distress estimation and final-report generation.

Every value here is a deterministic aggregate over the observations the
frontend collected during the live session - nothing is randomized, invented,
or produced by a language model. This is an expression-based ESTIMATE, not a
psychological or medical assessment.
"""
from statistics import pstdev
from typing import Dict, List, Optional

from . import config

NEGATIVE_KEYS = ["sad", "angry", "fear", "disgust"]
ELEVATED_NEGATIVE_THRESHOLD = 40.0
MIN_VALID_OBSERVATIONS = 15


def _negative_prob(scores: Dict[str, float]) -> float:
    return sum(scores.get(k, 0.0) for k in NEGATIVE_KEYS)


def _positive_prob(scores: Dict[str, float]) -> float:
    return scores.get("happy", 0.0) + 0.5 * scores.get("surprise", 0.0)


def _dominant(scores: Dict[str, float]) -> str:
    return max(scores, key=scores.get)


def _avg_instability(observations: List[dict]) -> float:
    if len(observations) < 2:
        return 0.0
    per_emotion = {
        k: [o["emotion_scores"].get(k, 0.0) for o in observations] for k in config.EMOTION_KEYS
    }
    return sum(pstdev(series) for series in per_emotion.values()) / len(config.EMOTION_KEYS)


def build_report(
    observations: List[dict],
    voice_observations: Optional[List[dict]] = None,
    agreement_samples: Optional[List[float]] = None,
) -> dict:
    """Builds the session report.

    Face observations are the primary series. `voice_observations` and
    `agreement_samples` are optional: when absent, this produces exactly the
    face-only report it always did, so an existing face-only session is
    unaffected by the addition of voice.
    """
    voice_observations = voice_observations or []
    agreement_samples = agreement_samples or []
    total = len(observations)
    valid = [o for o in observations if o.get("emotion_scores")]
    valid_count = len(valid)

    if valid_count < MIN_VALID_OBSERVATIONS:
        return {
            "success": True,
            "insufficient_data": True,
            "message": (
                f"At least {MIN_VALID_OBSERVATIONS} valid observations are recommended "
                f"for a meaningful session summary ({valid_count} available)."
            ),
            "valid_observations": valid_count,
            "total_observations": total,
        }

    # Frontend timestamps are Date.now() milliseconds; convert to seconds for duration math.
    timestamps = [o["timestamp"] for o in valid]
    duration_seconds = (max(timestamps) - min(timestamps)) / 1000 if len(timestamps) > 1 else 0.0

    negative_series = [_negative_prob(o["emotion_scores"]) for o in valid]
    positive_series = [_positive_prob(o["emotion_scores"]) for o in valid]
    dominant_series = [_dominant(o["emotion_scores"]) for o in valid]
    quality_series = [o.get("quality", 0.0) for o in valid]
    confidence_series = [o.get("confidence", 0.0) for o in valid]
    intensity_series = [o.get("expression_intensity", 0.0) for o in valid]

    avg_negative = sum(negative_series) / valid_count
    avg_positive = sum(positive_series) / valid_count
    peak_negative = max(negative_series)
    sustained_ratio = sum(1 for n in negative_series if n > ELEVATED_NEGATIVE_THRESHOLD) / valid_count

    instability_score = min(100.0, _avg_instability(valid) * 2.5)
    stability_score = round(max(0.0, 100.0 - instability_score), 1)

    avg_quality = sum(quality_series) / valid_count
    avg_confidence = sum(confidence_series) / valid_count
    low_confidence_count = sum(1 for c in confidence_series if c < config.CONFIDENCE_LOW)
    excluded_count = total - valid_count

    # --- Voice / text negative signal (optional modalities) ---------------
    voice_valid = [v for v in voice_observations if v.get("voice_scores")]
    text_valid = [v for v in voice_observations if v.get("text_scores")]

    voice_negative = (
        sum(_negative_prob(v["voice_scores"]) for v in voice_valid) / len(voice_valid)
        if voice_valid
        else None
    )
    text_negative = (
        sum(_negative_prob(v["text_scores"]) for v in text_valid) / len(text_valid)
        if text_valid
        else None
    )
    voice_stress = (
        sum(v.get("voice_stress", 0.0) for v in voice_valid) / len(voice_valid)
        if voice_valid
        else None
    )

    # --- Expression + Speech Distress Estimate ---------------------------
    # Transparent weighted sum over the components in config.DISTRESS_WEIGHTS.
    # Weights for modalities that produced no data are redistributed across
    # the components that did, so a face-only session is scored on face
    # evidence rather than being penalised (or credited) for absent audio.
    w = config.DISTRESS_WEIGHTS
    components: Dict[str, float] = {
        "sustained_negative": min(100.0, avg_negative * (0.5 + 0.5 * sustained_ratio)),
        "persistence": sustained_ratio * 100.0,
        "instability": instability_score,
    }
    if voice_negative is not None:
        # Blend the model's negative voice probability with the descriptive
        # vocal-pattern composite (pitch/energy variability, rate, pauses).
        components["voice_negative"] = min(
            100.0, 0.7 * voice_negative + 0.3 * (voice_stress or 0.0) * 100.0
        )
    if text_negative is not None:
        components["text_negative"] = min(100.0, text_negative)

    active_weight = sum(w[k] for k in components)
    distress_raw = (
        sum(w[k] * v for k, v in components.items()) / active_weight if active_weight else 0.0
    )

    # Scale by how trustworthy the observations were, and relieve by sustained
    # positive expression. A single sad frame or one sad word cannot drive this
    # high: every component above is a session-level aggregate, not a sample.
    reliability_factor = 0.5 + 0.5 * (avg_quality / 100)
    distress_score = round(
        max(0.0, min(100.0, distress_raw * reliability_factor - avg_positive * 0.15)), 1
    )

    if distress_score < 25:
        distress_level = "Low"
    elif distress_score < 50:
        distress_level = "Mild"
    elif distress_score < 75:
        distress_level = "Elevated"
    else:
        distress_level = "High"

    observation_factor = min(1.0, valid_count / 20) * 100
    duration_factor = min(1.0, duration_seconds / 20) * 100
    distress_confidence = round((observation_factor + avg_quality + stability_score + duration_factor) / 4, 1)

    sentiment_totals = {"positive": 0.0, "neutral": 0.0, "negative": 0.0}
    sentiment_count = 0
    for o in valid:
        s = o.get("sentiment")
        if s:
            for k in sentiment_totals:
                sentiment_totals[k] += s.get(k, 0.0)
            sentiment_count += 1
    if sentiment_count:
        sentiment_avg = {k: round(v / sentiment_count, 1) for k, v in sentiment_totals.items()}
    else:
        sentiment_avg = {"positive": 0.0, "neutral": 0.0, "negative": 0.0}
    sentiment_dominant = max(sentiment_avg, key=sentiment_avg.get)

    emotion_distribution = {
        k: round(sum(o["emotion_scores"].get(k, 0.0) for o in valid) / valid_count, 1)
        for k in config.EMOTION_KEYS
    }
    dominant_emotion = max(emotion_distribution, key=emotion_distribution.get)

    avg_intensity = round(sum(intensity_series) / valid_count, 1) if intensity_series else 0.0
    peak_intensity = round(max(intensity_series), 1) if intensity_series else 0.0

    overall_reaction = (
        f"Predominantly {sentiment_dominant} facial expression "
        f"(average expression intensity {avg_intensity:.0f}/100)."
    )

    transitions: Dict[str, int] = {}
    for prev, curr in zip(dominant_series, dominant_series[1:]):
        if prev != curr:
            key = f"{prev} -> {curr}"
            transitions[key] = transitions.get(key, 0) + 1
    top_transitions = sorted(transitions.items(), key=lambda kv: kv[1], reverse=True)[:6]

    key_observations = [
        f"{dominant_emotion.capitalize()} expression was the dominant detected expression.",
        f"Overall sentiment remained predominantly {sentiment_dominant}.",
        f"{valid_count} valid observations were available for the report.",
    ]
    if excluded_count > 0:
        key_observations.append(f"{excluded_count} low-quality observation(s) were excluded.")
    if sustained_ratio > 0.2:
        key_observations.append(
            f"Elevated negative-expression probability was observed during "
            f"{round(sustained_ratio * 100)}% of the session."
        )
    if instability_score > 40:
        key_observations.append("Expression variability increased during the session.")

    reasons: List[str] = []
    if sustained_ratio > 0.2:
        reasons.append("Repeated negative-expression probability across the session.")
    midpoint = valid_count // 2
    if midpoint > 0:
        first_half_negative = sum(negative_series[:midpoint]) / midpoint
        second_half_negative = sum(negative_series[midpoint:]) / (valid_count - midpoint)
        if second_half_negative - first_half_negative > 10:
            reasons.append("Negative-expression probability increased during the later part of the session.")

        first_half_instability = _avg_instability(valid[:midpoint]) if midpoint > 1 else 0.0
        second_half_instability = _avg_instability(valid[midpoint:]) if (valid_count - midpoint) > 1 else 0.0
        if second_half_instability - first_half_instability > 5:
            reasons.append("Increased expression variability during the final segment.")
    if peak_negative - avg_negative > 30:
        reasons.append("A temporary spike in negative-expression probability was detected.")
    if voice_negative is not None and voice_negative > 35:
        reasons.append(
            f"Voice tone carried elevated negative probability "
            f"(avg {voice_negative:.0f}% across {len(voice_valid)} audio window(s))."
        )
    if text_negative is not None and text_negative > 35:
        reasons.append(
            f"Spoken content was predominantly negative "
            f"(avg {text_negative:.0f}% across {len(text_valid)} transcript(s))."
        )
    if not reasons:
        reasons.append("No sustained negative-expression pattern was detected.")

    # --- Multimodal section (only when voice/text data was actually present) --
    multimodal = None
    if voice_valid or text_valid or agreement_samples:
        voice_distribution = (
            {
                k: round(sum(v["voice_scores"].get(k, 0.0) for v in voice_valid) / len(voice_valid), 1)
                for k in config.EMOTION_KEYS
            }
            if voice_valid
            else None
        )
        text_distribution = (
            {
                k: round(sum(v["text_scores"].get(k, 0.0) for v in text_valid) / len(text_valid), 1)
                for k in config.EMOTION_KEYS
            }
            if text_valid
            else None
        )
        avg_agreement = (
            round(sum(agreement_samples) / len(agreement_samples), 1) if agreement_samples else None
        )

        transcripts = [v["transcript"] for v in voice_observations if v.get("transcript")]

        multimodal = {
            "face": {"dominant": dominant_emotion, "distribution": emotion_distribution},
            "voice": (
                {
                    "dominant": max(voice_distribution, key=voice_distribution.get),
                    "distribution": voice_distribution,
                    "observations": len(voice_valid),
                    "avg_confidence": round(
                        sum(v.get("voice_confidence", 0.0) for v in voice_valid) / len(voice_valid), 1
                    ),
                }
                if voice_distribution
                else None
            ),
            "text": (
                {
                    "dominant": max(text_distribution, key=text_distribution.get),
                    "distribution": text_distribution,
                    "observations": len(text_valid),
                    "avg_confidence": round(
                        sum(v.get("text_confidence", 0.0) for v in text_valid) / len(text_valid), 1
                    ),
                }
                if text_distribution
                else None
            ),
            "signal_agreement": avg_agreement,
            "agreement_label": (
                "high" if avg_agreement is not None and avg_agreement >= 70
                else "moderate" if avg_agreement is not None and avg_agreement >= 45
                else "low" if avg_agreement is not None
                else None
            ),
            "transcript_excerpt": " ".join(transcripts)[-500:] if transcripts else None,
            "voice_stress_average": round(voice_stress, 3) if voice_stress is not None else None,
        }

        # Report disagreement explicitly rather than presenting a unified
        # conclusion the evidence does not support.
        dominants = {"face": dominant_emotion}
        if voice_distribution:
            dominants["voice"] = max(voice_distribution, key=voice_distribution.get)
        if text_distribution:
            dominants["text"] = max(text_distribution, key=text_distribution.get)
        if len(set(dominants.values())) > 1:
            readable = ", ".join(f"{k}={v}" for k, v in sorted(dominants.items()))
            key_observations.append(
                f"Modalities did not agree ({readable}); the overall estimate is "
                f"correspondingly less reliable."
            )
        elif len(dominants) > 1:
            key_observations.append(
                f"All available modalities agreed on '{dominant_emotion}'."
            )

    return {
        "success": True,
        "insufficient_data": False,
        "session": {
            "duration_seconds": round(duration_seconds, 1),
            "total_observations": total,
            "valid_observations": valid_count,
            "analysis_quality": round(valid_count / total * 100, 1) if total else 0.0,
        },
        "dominant_emotion": dominant_emotion,
        "overall_reaction": overall_reaction,
        "expression_intensity": {"average": avg_intensity, "peak": peak_intensity},
        "emotion_distribution": emotion_distribution,
        "sentiment": {**sentiment_avg, "dominant": sentiment_dominant},
        "distress": {
            "score": distress_score,
            "level": distress_level,
            "confidence": distress_confidence,
            # Named so the UI cannot present this as a clinical measure.
            "label": (
                "Expression + Speech Distress Estimate"
                if (voice_valid or text_valid)
                else "Expression-Based Distress Estimate"
            ),
            "components": {k: round(v, 1) for k, v in components.items()},
        },
        "multimodal": multimodal,
        "emotional_stability": stability_score,
        "transitions": [{"transition": t, "count": c} for t, c in top_transitions],
        "key_observations": key_observations,
        "distress_reasons": reasons,
        "reliability_summary": {
            "overall_reliability": round((avg_quality + avg_confidence) / 2, 1),
            "high_quality_observations": valid_count - low_confidence_count,
            "low_quality_observations": low_confidence_count + excluded_count,
            "average_face_quality": "Good" if avg_quality >= 70 else "Acceptable" if avg_quality >= 40 else "Poor",
            "temporal_consistency": "Good" if stability_score >= 70 else "Moderate" if stability_score >= 40 else "Low",
        },
    }
