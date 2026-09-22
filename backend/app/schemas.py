from typing import Dict, List, Optional
from pydantic import BaseModel, Field


class EmotionScores(BaseModel):
    angry: float
    disgust: float
    fear: float
    happy: float
    sad: float
    surprise: float
    neutral: float


class EmotionResult(BaseModel):
    """The FINAL fused result. `scores` is the fused distribution - never
    DeepFace's raw output, which is exposed separately under `debug`."""

    dominant: str
    confidence: float
    reliability: float
    reliability_label: str
    expression_intensity: float
    overall_reaction: str
    scores: EmotionScores
    session_dominant: Optional[str] = None
    recent_reaction: Optional[str] = None
    reasons: List[str] = []


class SentimentScores(BaseModel):
    positive: float
    neutral: float
    negative: float


class SentimentResult(BaseModel):
    dominant: str
    scores: SentimentScores


class FacialEvidence(BaseModel):
    """Region-level geometric evidence, 0-100."""

    smile: float
    mouth: float
    eyes: float
    eyebrows: float
    facial_motion: float


class QualityInfo(BaseModel):
    overall: float
    label: str
    blur: float
    brightness: float
    face_size: float
    head_pose_ok: bool


class ReactionInfo(BaseModel):
    previous: Optional[str] = None
    current: str
    transition: Optional[str] = None
    intensity: float
    events: List[str] = []


class DebugInfo(BaseModel):
    """Diagnostics only - lets a result be interrogated rather than trusted.
    Raw DeepFace output lives here, never in the primary emotion payload."""

    deepface_dominant: str
    deepface_scores: EmotionScores
    signals: Dict[str, float] = {}
    region_motion: Dict[str, float] = {}
    temporal_support: Dict[str, float] = {}
    temporal_stability: float
    landmark_trust: float
    calibrating: bool
    yaw_ratio: float
    pitch_ratio: float
    roll_degrees: float
    valid_observations: int
    # Eye-region detail: blink transitions and iris gaze where available.
    eyes: Dict[str, object] = {}


class AnalyzeResponse(BaseModel):
    success: bool
    timestamp: str
    face_detected: bool
    analysis_used: bool = False
    message: Optional[str] = None
    error: Optional[str] = None
    emotion: Optional[EmotionResult] = None
    sentiment: Optional[SentimentResult] = None
    facial_evidence: Optional[FacialEvidence] = None
    quality: Optional[QualityInfo] = None
    reaction: Optional[ReactionInfo] = None
    debug: Optional[DebugInfo] = None


class Observation(BaseModel):
    """One facial observation. Unchanged from the face-only implementation so
    existing sessions and the facial report path keep working."""

    timestamp: float
    emotion_scores: Dict[str, float]
    sentiment: Optional[Dict[str, float]] = None
    confidence: float = 0.0
    quality: float = 0.0
    expression_intensity: float = 0.0


# --- Voice / speech / text -------------------------------------------------


class TextEmotionRequest(BaseModel):
    text: str
    language: Optional[str] = None


class TranscriptAnalysisRequest(BaseModel):
    """A validated/stable transcript segment to send to Groq for structured
    analysis. Only settled (final-pass) transcript should ever be sent here -
    never a partial, in-progress guess."""

    transcript: str
    session_id: Optional[str] = None


class GroqTranscriptAnalysis(BaseModel):
    """Groq's structured read of one transcript segment.

    Every field must be grounded ONLY in the transcript actually sent - the
    model is explicitly instructed not to invent personal information,
    symptoms, events or distress that the person did not actually say.
    """

    sentiment: str
    emotion: str
    confidence: float
    key_concerns: List[str] = Field(default_factory=list)
    themes: List[str] = Field(default_factory=list)
    supportive_response: str
    practical_suggestions: List[str] = Field(default_factory=list)
    model: str
    grounded_in_transcript: bool = True


class ModalityScores(BaseModel):
    """One modality's contribution to multimodal fusion."""

    scores: Dict[str, float]
    confidence: float = 0.0
    quality: float = 0.0


class DistressSignalRequest(BaseModel):
    """Rolling-window inputs for the live distress signal."""

    emotion_window: List[Dict[str, float]] = []
    sentiment_window: List[Dict[str, float]] = []
    voice_stress: Optional[float] = None
    face_motion: Optional[float] = None
    reliability: float = 100.0
    transcript: Optional[str] = None


class SaveSessionRequest(BaseModel):
    """A completed session, stored as derived signals only - never raw media."""

    duration_seconds: float = 0
    observed_emotion: Optional[str] = None
    emotion_confidence: Optional[float] = None
    distress_score: Optional[float] = None
    distress_level: Optional[str] = None
    sentiment_dominant: Optional[str] = None
    agreement: Optional[float] = None
    modalities: List[str] = []
    valid_observations: int = 0
    emotion_scores: Dict[str, float] = {}
    sentiment_scores: Dict[str, float] = {}
    factors: List[Dict] = []
    transcript_excerpt: Optional[str] = None
    notes: List[str] = []


class TrendInfo(BaseModel):
    direction: Optional[str] = None   # increasing | decreasing | stable
    emotion: Optional[str] = None
    delta: float = 0.0


class SessionAnalyzeRequest(BaseModel):
    """One-click multimodal analysis over the CURRENT live readings.

    The client supplies each modality's latest structured result (already
    produced by the CV / audio / NLP models) plus an optional trend summary.
    Stateless: the client owns the rolling session series.
    """

    face: Optional[ModalityScores] = None
    voice: Optional[ModalityScores] = None
    text: Optional[ModalityScores] = None
    # Extra context used only for the explanation, never for scoring.
    face_detail: Optional[Dict] = None
    voice_detail: Optional[Dict] = None
    text_detail: Optional[Dict] = None
    trend: Optional[TrendInfo] = None


class MultimodalRequest(BaseModel):
    """Any subset of modalities may be supplied; missing ones are simply not
    fused (they never contribute a default)."""

    face: Optional[ModalityScores] = None
    voice: Optional[ModalityScores] = None
    text: Optional[ModalityScores] = None


class VoiceObservation(BaseModel):
    """One voice/text observation kept for the multimodal session report."""

    timestamp: float
    voice_scores: Optional[Dict[str, float]] = None
    voice_confidence: float = 0.0
    text_scores: Optional[Dict[str, float]] = None
    text_confidence: float = 0.0
    transcript: Optional[str] = None
    audio_quality: float = 0.0
    voice_stress: float = 0.0


class SessionReportRequest(BaseModel):
    """Face observations remain the primary series. Voice observations and
    per-modality agreement are optional, so a face-only session produces
    exactly the report it did before voice existed."""

    observations: List[Observation]
    voice_observations: List[VoiceObservation] = []
    agreement_samples: List[float] = []
