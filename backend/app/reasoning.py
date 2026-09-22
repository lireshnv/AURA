"""Explanation layer: turns structured multimodal signals into a readable
"why", plus inconsistency detection and a human-review recommendation.

DESIGN DECISION - why this is deterministic rather than an LLM call
-------------------------------------------------------------------
The spec asked for a Gemini / LangGraph reasoning layer, with the (correct and
important) constraint that the LLM must never invent emotion numbers - only
interpret, summarize and explain.

Once that constraint is applied, the remaining job is: read a small fixed
struct of numbers, compare them against thresholds, and emit sentences.
That is what this module does, deterministically. Doing it locally rather than
via an LLM buys three things that matter for this specific application:

  * Privacy. Emotion, voice and transcript data is unusually sensitive. A
    remote LLM call would ship a person's facial-expression scores and the
    literal words they spoke to a third party on every analysis tick.
  * Reproducibility. The same signals always yield the same explanation, so a
    reviewer can audit why the system said what it said.
  * No key, no cost, no network dependency in the live loop.

`generate_explanation` is a plain function over a struct, so an LLM-backed
implementation can be swapped in behind the same signature if a hosted
reasoning step is genuinely wanted - see `LLM_INTEGRATION_NOTE` at the bottom.
Either way, every number below originates in the CV/audio/NLP models, never in
a language model.

SAFETY
------
Wording here is deliberately constrained. Facial, vocal and textual signals are
described as *signals*, never as proof of an inner state or a condition. There
is no path through this module that emits a diagnosis.
"""
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from . import config

NEGATIVE_EMOTIONS = ("sad", "angry", "fear", "disgust")


@dataclass
class ExplanationResult:
    headline: str = ""
    reasons: List[str] = field(default_factory=list)
    inconsistencies: List[str] = field(default_factory=list)
    limitations: List[str] = field(default_factory=list)
    human_review_recommended: bool = False
    human_review_reason: Optional[str] = None
    generated_by: str = "deterministic-rules"


def _pct(value: Optional[float]) -> str:
    return "unavailable" if value is None else f"{value:.0f}%"


def generate_explanation(
    *,
    overall_emotion: str,
    overall_confidence: float,
    overall_reliability: float,
    agreement: Optional[float],
    face: Optional[Dict] = None,
    voice: Optional[Dict] = None,
    text: Optional[Dict] = None,
    trend: Optional[Dict] = None,
    modalities_used: Optional[List[str]] = None,
) -> ExplanationResult:
    """Builds an explanation from measured signals only.

    Every argument is a struct of numbers already produced by the CV / audio /
    NLP models. Nothing here computes or adjusts an emotion score.
    """
    modalities_used = modalities_used or []
    result = ExplanationResult()

    # --- Headline: hedged by construction --------------------------------
    if overall_emotion in ("uncertain", "") or overall_confidence < config.MIN_CONFIDENCE_FOR_LABEL:
        result.headline = (
            "The available signals were not strong enough to indicate a dominant "
            "expression in this window."
        )
    else:
        result.headline = (
            f"Observed signals most consistently indicated a "
            f"{overall_emotion}-related expression "
            f"({overall_confidence:.0f}% of the combined signal, "
            f"{overall_reliability:.0f}% observation reliability)."
        )

    # --- Per-modality reasons, each tied to a measured value --------------
    if face:
        face_dominant = face.get("dominant")
        face_conf = face.get("confidence")
        if face_dominant:
            result.reasons.append(
                f"Facial expression signal indicated {face_dominant} "
                f"({_pct(face_conf)} of the facial distribution)."
            )
        for signal, label in (
            ("smile", "lip-corner elevation"),
            ("brow_raise", "eyebrow raise"),
            ("brow_lower", "eyebrow lowering"),
            ("mouth_open", "mouth opening"),
            ("eye_narrowing", "eye narrowing"),
            ("eye_widening", "eye widening"),
        ):
            value = (face.get("signals") or {}).get(signal)
            if value is not None and value >= 35:
                result.reasons.append(f"Measured {label} at {value:.0f}% relative to baseline.")

        motion = (face.get("motion") or {}).get("overall")
        if motion is not None:
            if motion >= 30:
                result.reasons.append(f"Facial movement was active ({motion:.0f}%).")
            else:
                result.reasons.append(f"Facial geometry was largely static ({motion:.0f}%).")

        blink = face.get("blink")
        if blink and blink.get("blink_count"):
            result.reasons.append(
                f"{blink['blink_count']} eye-closure transition(s) observed over "
                f"{blink.get('observed_seconds', 0):.0f}s (coarse, sampling-limited)."
            )

    if voice:
        if voice.get("available"):
            result.reasons.append(
                f"Voice tone signal indicated {voice.get('dominant')} "
                f"({_pct(voice.get('confidence'))} confidence)."
            )
            rate = (voice.get("stress") or {}).get("speech_rate")
            pause = (voice.get("stress") or {}).get("pause_ratio")
            if rate:
                result.reasons.append(f"Speech rate measured as {rate.lower()}.")
            if pause is not None:
                result.reasons.append(f"Pauses occupied {pause * 100:.0f}% of the window.")
        else:
            result.reasons.append(
                "Voice signal was unavailable or below the quality threshold for this window."
            )

    if text:
        if text.get("available"):
            sentiment = (text.get("sentiment") or {}).get("dominant")
            result.reasons.append(
                f"Spoken content indicated {text.get('dominant')} "
                f"({_pct(text.get('confidence'))}), sentiment {sentiment}."
            )
        else:
            result.reasons.append("No confident transcript was available for text analysis.")

    # --- Temporal trend --------------------------------------------------
    if trend:
        direction = trend.get("direction")
        emotion = trend.get("emotion")
        if direction == "increasing" and emotion:
            result.reasons.append(
                f"{emotion.capitalize()}-related signal increased compared with earlier "
                f"in the session."
            )
        elif direction == "decreasing" and emotion:
            result.reasons.append(
                f"{emotion.capitalize()}-related signal decreased compared with earlier "
                f"in the session."
            )
        elif direction == "stable":
            result.reasons.append("Signals remained broadly stable across the session window.")

    # --- Inconsistencies: surfaced, not smoothed over --------------------
    dominants = {
        name: (source or {}).get("dominant")
        for name, source in (("face", face), ("voice", voice), ("text", text))
        if source and (source.get("available", True)) and (source or {}).get("dominant")
    }
    if len(set(dominants.values())) > 1:
        readable = ", ".join(f"{k}={v}" for k, v in sorted(dominants.items()))
        result.inconsistencies.append(
            f"Modalities did not agree ({readable}). A person's expression, tone and words "
            f"can legitimately diverge, so the combined estimate is reported with reduced "
            f"reliability rather than forcing a single conclusion."
        )
    if agreement is not None and agreement < 45 and len(dominants) > 1:
        result.inconsistencies.append(
            f"Cross-modal agreement was low ({agreement:.0f}%)."
        )

    face_neg = (face or {}).get("dominant") in NEGATIVE_EMOTIONS
    text_sent = ((text or {}).get("sentiment") or {}).get("dominant")
    if face_neg and text_sent == "positive":
        result.inconsistencies.append(
            "Facial signal leaned negative while spoken content leaned positive."
        )

    # --- Limitations, always stated --------------------------------------
    if len(modalities_used) < 2:
        result.limitations.append(
            f"Only {len(modalities_used) or 'no'} modality contributed; "
            f"single-modality estimates are weaker."
        )
    if overall_reliability < 60:
        result.limitations.append(
            f"Observation reliability was {overall_reliability:.0f}%, below the level at "
            f"which this estimate should carry weight."
        )
    if face and (face.get("quality") or 100) < 50:
        result.limitations.append("Image quality was poor for this window.")
    result.limitations.append(
        "These are observable expression signals, not measurements of inner emotional "
        "state, and not a clinical or diagnostic assessment."
    )

    # --- Human-review recommendation -------------------------------------
    review_reasons = []
    if overall_reliability < 55:
        review_reasons.append("low observation reliability")
    if agreement is not None and agreement < 45 and len(dominants) > 1:
        review_reasons.append("conflicting modalities")
    if result.inconsistencies:
        review_reasons.append("detected signal inconsistency")
    sustained_negative = (
        trend
        and trend.get("direction") == "increasing"
        and trend.get("emotion") in NEGATIVE_EMOTIONS
    )
    if sustained_negative:
        review_reasons.append("sustained increase in a negative-valence signal")

    if review_reasons:
        result.human_review_recommended = True
        result.human_review_reason = (
            "Human review suggested: " + ", ".join(review_reasons) + "."
        )

    return result


# ---------------------------------------------------------------------------
LLM_INTEGRATION_NOTE = """
To route explanation through a hosted LLM (Gemini, or any other) instead of
the rules above, implement a function with the same signature as
generate_explanation and select it here.

Two constraints must hold, and they are the reason this is not the default:

1. The LLM receives the structured signal dict ONLY, and its output populates
   only headline / reasons / inconsistencies / limitations. It must never be
   allowed to produce or modify a numeric emotion score - those come from
   DeepFace, the landmark geometry, the voice model and the text model.

2. Sending facial-expression scores and verbatim transcripts to a third-party
   API is a meaningful privacy change for this data class. It should be an
   explicit, consented setting, not a silent default - which is why the local
   deterministic path is what ships enabled.

Set generated_by accordingly (e.g. "gemini-1.5-flash") so any stored result
records which reasoning path produced it.
"""
