"""Transcript validation pipeline: RAW -> CLEANUP -> VALIDATION -> FINAL.

Recognizer output (ElevenLabs Speech-to-Text) is not passed straight to the
UI. It is cleaned, and low-confidence segments are separated out instead of
being presented with the same authority as confident ones.

The hard rule here: this module NEVER invents or substitutes words. It only
    * drops segments the recognizer itself scored as unreliable,
    * removes known hallucination artefacts on silence,
    * normalizes whitespace and duplicate repeats.

"Context-aware correction" in the sense of guessing what someone probably
meant is deliberately NOT implemented. Rewriting a transcript toward what a
language model expects would fabricate speech that was never spoken - and
downstream this transcript feeds an emotion estimate, so an invented word
becomes invented evidence. Uncertain text is surfaced as uncertain instead.
"""
import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from . import config

# Some recognizers emit stock phrases when fed silence or noise (a known
# failure mode of small STT models in general). These are transcription
# artefacts, not speech, so they are removed rather than reported as
# something the user said.
_HALLUCINATION_PATTERNS = [
    re.compile(r"^\s*thanks? for watching[.!]?\s*$", re.I),
    re.compile(r"^\s*thank you for watching[.!]?\s*$", re.I),
    re.compile(r"^\s*please subscribe[.!]?\s*$", re.I),
    re.compile(r"^\s*subtitles? by.*$", re.I),
    re.compile(r"^\s*amara\.org.*$", re.I),
    re.compile(r"^\s*\[?\s*(music|silence|applause|blank_audio|inaudible)\s*\]?\s*$", re.I),
    re.compile(r"^\s*[.…]+\s*$"),
]


@dataclass
class CleanedTranscript:
    raw_text: str = ""
    # Confident text only - this is what feeds the emotion model.
    final_text: str = ""
    # Same text for display, with low-confidence stretches shown as [unclear]
    # in their original position.
    display_text: str = ""
    confident_segments: List[Dict] = field(default_factory=list)
    uncertain_segments: List[Dict] = field(default_factory=list)
    removed_segments: List[Dict] = field(default_factory=list)
    language: Optional[str] = None
    language_probability: Optional[float] = None
    language_reliable: bool = True
    # 0-100 share of retained segments that cleared the confidence bar.
    confidence_score: float = 0.0
    word_count: int = 0
    notes: List[str] = field(default_factory=list)


def _segment_confidence(segment: Dict) -> Optional[float]:
    """Maps a segment's avg_logprob to a 0-1 indicator, or None if absent."""
    logprob = segment.get("avg_logprob")
    if logprob is None:
        return None
    return max(0.0, min(1.0, 1.0 + float(logprob)))


def _is_artefact(text: str) -> bool:
    return any(p.match(text) for p in _HALLUCINATION_PATTERNS)


def _normalize(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    # Collapse an immediately repeated word ("the the" -> "the"), a common
    # recognizer stutter. Case-insensitive but preserves the first occurrence.
    text = re.sub(r"\b(\w+)(\s+\1\b)+", r"\1", text, flags=re.I)
    return text


def clean_transcript(
    raw_text: str,
    segments: List[Dict],
    language: Optional[str] = None,
    language_probability: Optional[float] = None,
) -> CleanedTranscript:
    """Runs the validation pipeline over one window's Whisper output."""
    result = CleanedTranscript(
        raw_text=raw_text or "",
        language=language,
        language_probability=language_probability,
    )

    # --- Language validation ---------------------------------------------
    if language_probability is not None:
        result.language_reliable = language_probability >= config.LANGUAGE_MIN_PROBABILITY
        if not result.language_reliable:
            result.notes.append(
                f"Detected language '{language}' is low-confidence "
                f"({language_probability * 100:.0f}%); transcript and text emotion "
                f"may be unreliable."
            )

    if not segments:
        cleaned = _normalize(result.raw_text)
        if cleaned and not _is_artefact(cleaned):
            result.final_text = cleaned
            result.display_text = cleaned
            result.word_count = len(cleaned.split())
            result.confidence_score = 0.0
            result.notes.append(
                "No per-segment timing from the recognizer; transcript retained "
                "without per-segment confidence."
            )
        return result

    # --- Cleanup + confidence split --------------------------------------
    for segment in segments:
        text = _normalize(segment.get("text", ""))
        entry = {
            "start": segment.get("start", 0.0),
            "end": segment.get("end", 0.0),
            "text": text,
        }

        if not text:
            continue

        if _is_artefact(text):
            entry["reason"] = "recognizer artefact on silence/noise"
            result.removed_segments.append(entry)
            continue

        confidence = _segment_confidence(segment)
        if confidence is not None:
            entry["confidence"] = round(confidence * 100, 1)

        if confidence is not None and confidence < config.SEGMENT_MIN_CONFIDENCE:
            # Kept, but quarantined: shown to the user as uncertain and excluded
            # from the text-emotion input so shaky words cannot become evidence.
            entry["reason"] = "below confidence threshold"
            result.uncertain_segments.append(entry)
        else:
            result.confident_segments.append(entry)

    # --- Final transcript = confident segments only -----------------------
    result.final_text = _normalize(
        " ".join(s["text"] for s in result.confident_segments)
    )

    # Display transcript keeps chronological position, marking low-confidence
    # stretches as [unclear] rather than dropping them silently (which would
    # imply nothing was said) or printing them as if they were reliable.
    ordered = sorted(
        [(s, True) for s in result.confident_segments]
        + [(s, False) for s in result.uncertain_segments],
        key=lambda pair: pair[0].get("start", 0.0),
    )
    display_parts: List[str] = []
    for segment, confident in ordered:
        if confident:
            display_parts.append(segment["text"])
        elif not display_parts or display_parts[-1] != "[unclear]":
            display_parts.append("[unclear]")
    result.display_text = " ".join(display_parts).strip()
    result.word_count = len(result.final_text.split()) if result.final_text else 0

    total_kept = len(result.confident_segments) + len(result.uncertain_segments)
    result.confidence_score = (
        round(len(result.confident_segments) / total_kept * 100, 1) if total_kept else 0.0
    )

    if result.removed_segments:
        result.notes.append(
            f"{len(result.removed_segments)} recognizer artefact segment(s) removed."
        )
    if result.uncertain_segments:
        result.notes.append(
            f"{len(result.uncertain_segments)} low-confidence segment(s) shown separately "
            f"and excluded from text-emotion analysis."
        )
    if not result.final_text and result.uncertain_segments:
        result.notes.append(
            "All speech in this window was low-confidence; no confident transcript produced."
        )

    return result


def transcript_signal_quality(cleaned: CleanedTranscript) -> float:
    """0-100 quality of this transcript as an emotion-analysis input.

    Blends how much confident text there is with how confident it was. A
    two-word fragment is a weak basis for a text emotion estimate even if
    those two words were recognized perfectly.
    """
    if cleaned.word_count == 0:
        return 0.0
    length_factor = min(1.0, cleaned.word_count / config.TRANSCRIPT_TARGET_WORDS)
    confidence_factor = cleaned.confidence_score / 100
    language_factor = 1.0 if cleaned.language_reliable else 0.5
    return round(
        min(100.0, (0.5 * length_factor + 0.5 * confidence_factor) * language_factor * 100), 1
    )
