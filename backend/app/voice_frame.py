"""Validated schema for one real-time voice analysis window.

This is the contract between the voice pipeline and the UI. Every field the
frontend renders passes through here, so a malformed or missing value fails at
the boundary instead of becoming a confident-looking number on screen.

Two rules are enforced structurally rather than by convention:

1. OBSERVED IS NOT INTERPRETED. `VoiceSignal.observed` describes what was
   measured in the audio ("elevated vocal activation"). `VoiceSignal.emotion`
   is a model's guess at what it might mean. They are separate fields with
   separate confidences, and the emotion is Optional - when the evidence does
   not support naming one, it is None rather than "neutral". A UI cannot
   accidentally present the acoustic measurement as a psychological finding.

2. ABSENT IS NOT ZERO. Optional float fields are None when unmeasured. A pitch
   of 0.0 Hz would render as a real measurement of a silent voice; None renders
   as "unavailable". Normalised 0-1 bars are only populated when the underlying
   feature was actually computed.

Windows carry explicit start/end times on a session clock so a transcript and
an acoustic reading covering 00:05-00:08 can be aligned downstream.
"""
from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, Field, model_validator

# --- Building blocks -------------------------------------------------------


class WindowSpan(BaseModel):
    """The slice of the session this frame describes."""

    session_id: str = Field(min_length=1, max_length=128)
    # Seconds from session start. Monotonic within a session.
    window_start: float = Field(ge=0.0)
    window_end: float = Field(ge=0.0)
    # Unix milliseconds when the server produced the frame.
    timestamp: int = Field(ge=0)
    duration: float = Field(ge=0.0, le=120.0)

    @model_validator(mode="after")
    def _ordered(self) -> "WindowSpan":
        if self.window_end < self.window_start:
            raise ValueError("window_end must not precede window_start")
        return self


class TranscriptPart(BaseModel):
    """Text for this window.

    `is_final` distinguishes a fast partial pass, which may be revised, from a
    settled utterance-level pass. The UI must not present a partial as final -
    the whole point of streaming is that early text is provisional.
    """

    text: str = ""
    display_text: str = ""
    is_final: bool = False
    # 0-100. None when no transcript was produced at all, which is different
    # from a transcript the model is unsure about.
    confidence: Optional[float] = Field(default=None, ge=0.0, le=100.0)
    language: Optional[str] = None
    language_reliable: bool = False
    word_count: int = Field(default=0, ge=0)
    uncertain_segments: List[Dict] = Field(default_factory=list)
    available: bool = False
    error: Optional[str] = None


class TextEmotionPart(BaseModel):
    """Emotion of the WORDS, kept distinct from the emotion of the voice.

    Present so the existing multimodal fusion keeps its text branch when it
    consumes frames. Only confident transcript text reaches the model, so a
    shaky recognition cannot become emotion evidence.
    """

    available: bool = False
    dominant: Optional[str] = None
    scores: Dict[str, float] = Field(default_factory=dict)
    confidence: Optional[float] = Field(default=None, ge=0.0, le=100.0)
    sentiment: Dict[str, object] = Field(default_factory=dict)
    signal_quality: float = Field(default=0.0, ge=0.0, le=1.0)
    language_supported: bool = True
    error: Optional[str] = None


class Feature(BaseModel):
    """One acoustic measurement.

    Carries the raw value in its real unit AND a 0-1 normalised value for the
    bar display, because a bar alone cannot be checked against reality. `unit`
    exists so nothing has to guess how to label the raw number.
    """

    raw: Optional[float] = None
    normalized: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    unit: str = ""
    available: bool = False

    @model_validator(mode="after")
    def _consistent(self) -> "Feature":
        # An "available" feature with nothing in it would render as a zero bar
        # that looks like a real measurement of nothing.
        if self.available and self.raw is None and self.normalized is None:
            raise ValueError("feature marked available but carries no value")
        return self


class ProsodyFeatures(BaseModel):
    """The acoustic feature set for this window. All optional by design."""

    pitch: Feature = Field(default_factory=Feature)
    pitch_variation: Feature = Field(default_factory=Feature)
    energy: Feature = Field(default_factory=Feature)
    energy_variation: Feature = Field(default_factory=Feature)
    speech_rate: Feature = Field(default_factory=Feature)
    pause_ratio: Feature = Field(default_factory=Feature)
    voiced_ratio: Feature = Field(default_factory=Feature)
    spectral_centroid: Feature = Field(default_factory=Feature)
    voice_activity_seconds: Feature = Field(default_factory=Feature)
    # Voice quality (Praat: jitter/shimmer/HNR). See voice_signal.py for the
    # clinical reference points behind the normalized scale.
    jitter: Feature = Field(default_factory=Feature)
    shimmer: Feature = Field(default_factory=Feature)
    hnr: Feature = Field(default_factory=Feature)

    def measured(self) -> List[str]:
        return [name for name, f in self if isinstance(f, Feature) and f.available]


class VoiceSignal(BaseModel):
    """What the voice sounded like, and - separately - what it might mean."""

    # OBSERVED: a description of the acoustic measurement itself. Always
    # phrased as a property of the signal, never of the person.
    observed: str
    # 0-100 confidence in the OBSERVATION, driven by how much of the feature
    # set was actually measurable and how strong the deviation was.
    confidence: float = Field(ge=0.0, le=100.0)
    # Which features drove the observation, so the reading is auditable.
    contributing_features: List[str] = Field(default_factory=list)

    # INTERPRETED: the voice-emotion model's label. None when the model is
    # unavailable or too unsure - never defaulted to "neutral", which would
    # manufacture a finding out of an absence of evidence.
    emotion: Optional[str] = None
    emotion_confidence: Optional[float] = Field(default=None, ge=0.0, le=100.0)
    emotion_scores: Dict[str, float] = Field(default_factory=dict)

    # Fixed disclaimer travelling with the data, so it cannot be dropped by a
    # UI that forgets to add it.
    interpretation_note: str = (
        "Acoustic observation only. Voice characteristics are not a diagnosis "
        "and do not establish how the speaker feels."
    )

    @model_validator(mode="after")
    def _emotion_pairing(self) -> "VoiceSignal":
        if self.emotion is not None and self.emotion_confidence is None:
            raise ValueError("a named emotion must carry a confidence")
        return self


class SignalQuality(BaseModel):
    """Per-stream quality, so a low-confidence reading says WHICH input was weak."""

    audio: Literal["good", "fair", "poor", "unavailable"] = "unavailable"
    speech: Literal["good", "fair", "poor", "none"] = "none"
    transcript: Literal["high", "medium", "low", "none"] = "none"
    audio_score: Optional[float] = Field(default=None, ge=0.0, le=100.0)
    notes: List[str] = Field(default_factory=list)


class Latency(BaseModel):
    """Measured server-side stage timings in milliseconds, for profiling."""

    decode_ms: float = Field(default=0.0, ge=0.0)
    features_ms: float = Field(default=0.0, ge=0.0)
    # The wav2vec2 tone model. Zero on partial windows, where it is skipped
    # deliberately - it is the most expensive single stage.
    tone_ms: float = Field(default=0.0, ge=0.0)
    transcribe_ms: float = Field(default=0.0, ge=0.0)
    total_ms: float = Field(default=0.0, ge=0.0)
    # True when both branches were dispatched concurrently. Deliberately NOT
    # inferred from timings: when one branch is much shorter than the other,
    # wall time is dominated by the longer one and a "wall < sum" test reports
    # a false negative even though the branches did overlap.
    parallel: bool = False
    # How much wall time the overlap actually saved. This is the honest
    # measurement - 0 means the branches did not overlap in practice, whatever
    # the dispatch did.
    overlap_saved_ms: float = Field(default=0.0, ge=0.0)


# --- The frame -------------------------------------------------------------


class VoiceAnalysisFrame(BaseModel):
    """One synchronized real-time voice result.

    `analysis_used` is the honesty switch. False means this window produced no
    finding - too short, too quiet, no speech - and the UI must show the reason
    rather than the previous reading or an invented one.
    """

    model_config = {"extra": "forbid"}

    window: WindowSpan
    analysis_used: bool = False
    speech_detected: bool = False
    message: Optional[str] = None
    error: Optional[str] = None

    transcript: TranscriptPart = Field(default_factory=TranscriptPart)
    text_emotion: TextEmotionPart = Field(default_factory=TextEmotionPart)
    prosody: ProsodyFeatures = Field(default_factory=ProsodyFeatures)
    voice_signal: Optional[VoiceSignal] = None
    quality: SignalQuality = Field(default_factory=SignalQuality)
    latency: Latency = Field(default_factory=Latency)

    # Overall 0-100 confidence in this frame as a whole.
    confidence: float = Field(default=0.0, ge=0.0, le=100.0)

    @model_validator(mode="after")
    def _no_finding_without_analysis(self) -> "VoiceAnalysisFrame":
        # The bug this prevents: a skipped window still carrying a voice signal
        # from a populated default, which the UI would render as a live reading
        # while nothing was actually analysed.
        if not self.analysis_used:
            if self.voice_signal is not None:
                raise ValueError("voice_signal present on a frame that was not analysed")
            if self.confidence > 0:
                raise ValueError("confidence must be 0 when no analysis was used")
            if not self.message and not self.error:
                raise ValueError("an unanalysed frame must explain why")
        return self
