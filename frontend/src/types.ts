export interface EmotionScores {
  angry: number
  disgust: number
  fear: number
  happy: number
  sad: number
  surprise: number
  neutral: number
}

export type ReliabilityLabel = "low" | "moderate" | "good" | "high"
export type OverallReaction = "Minimal" | "Mild" | "Moderate" | "Strong"

/** The FINAL fused result. `scores` is the fused distribution the whole UI
 *  displays - raw DeepFace output is only ever shown in the debug panel. */
export interface EmotionResult {
  dominant: string
  confidence: number
  reliability: number
  reliability_label: ReliabilityLabel
  expression_intensity: number
  overall_reaction: OverallReaction
  scores: EmotionScores
  session_dominant: string | null
  recent_reaction: string | null
  reasons: string[]
}

export interface SentimentScores {
  positive: number
  neutral: number
  negative: number
}

export interface SentimentResult {
  dominant: "positive" | "neutral" | "negative"
  scores: SentimentScores
}

export interface FacialEvidence {
  smile: number
  mouth: number
  eyes: number
  eyebrows: number
  facial_motion: number
}

export interface QualityInfo {
  overall: number
  label: "good" | "acceptable" | "poor" | "rejected"
  blur: number
  brightness: number
  face_size: number
  head_pose_ok: boolean
}

export interface ReactionInfo {
  previous: string | null
  current: string
  transition: string | null
  intensity: number
  events: string[]
}

/** Diagnostics only. Raw DeepFace lives here so a result can be interrogated. */
export interface DebugInfo {
  deepface_dominant: string
  deepface_scores: EmotionScores
  signals: Record<string, number>
  region_motion: Record<string, number>
  temporal_support: Record<string, number>
  temporal_stability: number
  landmark_trust: number
  calibrating: boolean
  yaw_ratio: number
  pitch_ratio: number
  roll_degrees: number
  valid_observations: number
  /** Eye-region detail: blink transitions and iris gaze where available. */
  eyes: {
    blink_count?: number
    blinks_per_minute?: number
    eye_currently_closed?: boolean
    sampling_limited?: boolean
    observed_seconds?: number
    left_openness?: number
    right_openness?: number
    asymmetry?: number
    iris_available?: boolean
    gaze_offset?: number | null
  }
}

export interface AnalyzeResponse {
  success: boolean
  timestamp: string
  face_detected: boolean
  analysis_used: boolean
  message?: string
  error?: string
  emotion?: EmotionResult
  sentiment?: SentimentResult
  facial_evidence?: FacialEvidence
  quality?: QualityInfo
  reaction?: ReactionInfo
  debug?: DebugInfo
}

export interface DebugMetrics {
  cameraActive: boolean
  backendConnected: boolean
  videoWidth: number
  videoHeight: number
  lastFrameSizeKb: number
  apiStatus: "connected" | "error" | "unknown"
  lastResponseMs: number | null
  lastAnalysisAt: number | null
  faceDetected: boolean
  analysisCount: number
  skippedCount: number
  lastError: string | null
  latest: AnalyzeResponse | null
}

/** One valid analysis kept for the live timeline and the final report. */
export interface Observation {
  timestamp: number
  emotion_scores: EmotionScores
  sentiment: SentimentScores
  confidence: number
  quality: number
  expression_intensity: number
}

export type PerformanceMode = "fast" | "balanced" | "power_saving"

// Analysis cadence per frame, not per second - the in-flight guard in
// LiveEmotionCamera (isAnalyzingRef) already skips a tick if the previous
// request hasn't returned yet, so tightening this is safe even though real
// per-frame inference is slower than these intervals: it just means "check
// as often as possible" rather than risking request pile-up.
export const MODE_INTERVALS: Record<PerformanceMode, number> = {
  fast: 400,
  balanced: 1000,
  power_saving: 2000,
}

export type CameraState =
  | "off"
  | "requesting_permission"
  | "ready"
  | "detecting"
  | "analyzing"
  | "result"
  | "error"

// =========================================================================
// VOICE / SPEECH / TEXT
// Separate from the facial types above; the facial pipeline does not use these.
// =========================================================================

export interface VoiceCapabilities {
  audio_decode: boolean
  acoustic_features: boolean
  vad: string
  speech_to_text: boolean
  voice_emotion: boolean
  text_emotion: boolean
  stt_model: string
}

export interface AudioQualityInfo {
  duration: number
  rms: number
  peak: number
  snr_db_estimate: number
  clipping_ratio: number
  silence_ratio: number
  score: number
  label: string
  acceptable: boolean
}

export interface TranscriptSegment {
  start: number
  end: number
  text: string
}

export interface TranscriptInfo {
  available: boolean
  text: string
  language: string | null
  language_probability: number | null
  segments: TranscriptSegment[]
  /** Derived from the recognizer's per-word logprob. An INDICATOR, not a
   *  calibrated accuracy figure; null means genuinely unavailable. */
  quality_indicator: number | null
  error?: string | null
}

export interface VoiceEmotionInfo {
  available: boolean
  dominant: string
  scores: Record<string, number>
  confidence: number
  raw_confidence: number
  supported_emotions: string[]
  quality_limited: boolean
  error?: string | null
}

export interface TextEmotionInfo {
  available: boolean
  dominant?: string
  scores?: Record<string, number>
  confidence?: number
  sentiment?: { dominant: string; scores: SentimentScores }
  language_supported?: boolean
  evidence?: string[]
  error?: string | null
}

/** Groq's structured, qualitative read of one settled transcript segment -
 * separate from the numeric local-model TextEmotionInfo above, which is what
 * actually feeds distress scoring. */
export interface GroqTranscriptAnalysis {
  available: boolean
  reason?: string
  sentiment?: string
  emotion?: string
  confidence?: number
  key_concerns?: string[]
  themes?: string[]
  supportive_response?: string
  practical_suggestions?: string[]
  model?: string
  grounded_in_transcript?: boolean
}

export interface AcousticInfo {
  available: boolean
  pitch: {
    mean_hz: number
    std_hz: number
    range_hz: number
    normalized: number
    variability: number
  }
  energy: { mean: number; std: number; normalized: number; variability: number }
  spectral: {
    zero_crossing_rate: number
    centroid: number
    bandwidth: number
    mfcc_mean: number[]
  }
  voiced_ratio: number
}

export interface VoiceStressInfo {
  available: boolean
  pitch_variability?: string
  pitch_variability_value?: number
  energy_variability?: string
  energy_variability_value?: number
  speech_rate?: string
  words_per_second?: number
  pause_ratio?: number
  contribution?: number
  contribution_label?: string
}

export interface SpeechTiming {
  words_per_second: number
  pause_ratio: number
  pause_count: number
  speech_ratio: number
}

export interface VoiceAnalysisResponse {
  success: boolean
  timestamp?: string
  speech_detected: boolean
  vad_method: string
  speech_ratio: number
  analysis_used: boolean
  message?: string | null
  error?: string | null
  quality: AudioQualityInfo | Record<string, never>
  transcript: TranscriptInfo | Record<string, never>
  voice: VoiceEmotionInfo | Record<string, never>
  text: TextEmotionInfo | Record<string, never>
  acoustic: AcousticInfo | Record<string, never>
  stress: VoiceStressInfo
  timing: SpeechTiming | Record<string, never>
}

// --- Real-time voice frame -------------------------------------------------
// Mirrors backend/app/voice_frame.py. Optional fields are genuinely optional:
// null means NOT MEASURED, which the UI must render as unavailable rather than
// as zero.

export interface VoiceWindowSpan {
  session_id: string
  window_start: number
  window_end: number
  timestamp: number
  duration: number
}

export interface VoiceTranscriptPart {
  text: string
  display_text: string
  /** False means provisional text that a later pass may replace. */
  is_final: boolean
  confidence: number | null
  language: string | null
  language_reliable: boolean
  word_count: number
  uncertain_segments: Array<Record<string, unknown>>
  available: boolean
  error: string | null
}

export interface VoiceFeature {
  raw: number | null
  /** 0-1 for the bar display. Null when the feature was not measured. */
  normalized: number | null
  unit: string
  available: boolean
}

export interface VoiceProsody {
  pitch: VoiceFeature
  pitch_variation: VoiceFeature
  energy: VoiceFeature
  energy_variation: VoiceFeature
  speech_rate: VoiceFeature
  pause_ratio: VoiceFeature
  voiced_ratio: VoiceFeature
  spectral_centroid: VoiceFeature
  voice_activity_seconds: VoiceFeature
  /** Voice quality (Praat: jitter/shimmer/HNR). Clinical-grade acoustic measures. */
  jitter: VoiceFeature
  shimmer: VoiceFeature
  hnr: VoiceFeature
}

export interface VoiceSignalInfo {
  /** What was MEASURED in the audio. A property of the signal, not the person. */
  observed: string
  confidence: number
  contributing_features: string[]
  /** A model's INTERPRETATION. Null when the evidence does not support one. */
  emotion: string | null
  emotion_confidence: number | null
  emotion_scores: Record<string, number>
  interpretation_note: string
}

export interface VoiceSignalQuality {
  audio: "good" | "fair" | "poor" | "unavailable"
  speech: "good" | "fair" | "poor" | "none"
  transcript: "high" | "medium" | "low" | "none"
  audio_score: number | null
  notes: string[]
}

export interface VoiceLatency {
  decode_ms: number
  features_ms: number
  /** Zero on partial windows: the tone model runs only on the final pass. */
  tone_ms: number
  transcribe_ms: number
  total_ms: number
  /** Both branches dispatched concurrently. */
  parallel: boolean
  /** Wall time the overlap actually saved. 0 means no real overlap. */
  overlap_saved_ms: number
}

/** Emotion of the WORDS, kept distinct from the emotion of the voice. */
export interface VoiceTextEmotion {
  available: boolean
  dominant: string | null
  scores: Record<string, number>
  confidence: number | null
  sentiment: Record<string, unknown>
  signal_quality: number
  language_supported: boolean
  error: string | null
}

export interface VoiceFrame {
  window: VoiceWindowSpan
  analysis_used: boolean
  speech_detected: boolean
  message?: string | null
  error?: string | null
  transcript: VoiceTranscriptPart
  text_emotion: VoiceTextEmotion
  prosody: VoiceProsody
  voice_signal: VoiceSignalInfo | null
  quality: VoiceSignalQuality
  latency: VoiceLatency
  confidence: number
}

export interface MultimodalResponse {
  success: boolean
  timestamp?: string
  error?: string
  emotion: {
    dominant: string
    scores: EmotionScores
    confidence: number
    reliability: number
  }
  sentiment: { dominant: string; scores: SentimentScores }
  agreement: {
    score: number
    label: "high" | "moderate" | "low" | "unknown"
    disagreement: boolean
    per_modality_dominant: Record<string, string>
  }
  modalities_used: string[]
  effective_weights: Record<string, number>
  notes: string[]
}

/** One voice/text observation retained for the multimodal session report. */
export interface VoiceObservation {
  timestamp: number
  voice_scores: Record<string, number> | null
  voice_confidence: number
  text_scores: Record<string, number> | null
  text_confidence: number
  transcript: string | null
  audio_quality: number
  voice_stress: number
}

/** Result of the one-click /api/session/analyze call. */
export interface AuraAnalysis {
  success: boolean
  timestamp?: string
  error?: string
  combined: {
    dominant: string
    scores: EmotionScores
    signal: number
    confidence: number
    reliability: number
  }
  per_modality: {
    face: { signal: number; quality: number; scores: Record<string, number> } | null
    voice: { signal: number; quality: number; scores: Record<string, number> } | null
    text: { signal: number; quality: number; scores: Record<string, number> } | null
  }
  sentiment: { dominant: string; scores: SentimentScores }
  agreement: {
    score: number
    label: "high" | "moderate" | "low" | "unknown"
    disagreement: boolean
    per_modality_dominant: Record<string, string>
  }
  modalities_used: string[]
  effective_weights: Record<string, number>
  explanation: {
    headline: string
    reasons: string[]
    inconsistencies: string[]
    limitations: string[]
    human_review_recommended: boolean
    human_review_reason: string | null
    generated_by: string
  }
  notes: string[]
}

export interface DistressFactor {
  label: string
  direction: "up" | "down" | "neutral"
  detail: string
}

export interface EmotionalTheme {
  theme: string
  matches: string[]
  count: number
}

export interface DistressSignalResponse {
  success: boolean
  timestamp?: string
  score: number
  level: "GREEN" | "AMBER" | "RED"
  confidence: number
  factors: DistressFactor[]
  components: Record<string, number>
  factor_weights: Record<string, number>
  insufficient_data: boolean
  disclaimer: string
  themes: EmotionalTheme[]
}

export interface HistorySession {
  id: string
  created_at: string
  duration_seconds: number
  observed_emotion: string | null
  emotion_confidence: number | null
  distress_score: number | null
  distress_level: string | null
  sentiment_dominant: string | null
  agreement: number | null
  modalities: string[]
  valid_observations: number
  emotion_scores: Record<string, number>
  sentiment_scores: Record<string, number>
  factors: DistressFactor[]
  transcript_excerpt: string | null
  notes: string[]
}

export interface HistoryResponse {
  success: boolean
  sessions: HistorySession[]
  count: number
  trend: {
    direction: "increasing" | "decreasing" | "stable" | "insufficient"
    delta: number
    sessions_compared: number
    label: string
  }
}

/** Live pipeline stage indicators for the one-click flow. */
export interface PipelineStatus {
  camera: "off" | "starting" | "active" | "error"
  microphone: "off" | "starting" | "active" | "error"
  face: "idle" | "detected" | "not_detected"
  voice: "idle" | "speech" | "silence"
  transcript: "idle" | "receiving" | "none"
}

/** One point on the aligned multimodal timeline. */
export interface MultimodalTimelinePoint {
  timestamp: number
  face: string | null
  voice: string | null
  text: string | null
  overall: string | null
  agreement: number | null
}

export interface DistressInfo {
  score: number
  level: "Low" | "Mild" | "Elevated" | "High"
  confidence: number
  label?: string
  components?: Record<string, number>
}

export interface TransitionInfo {
  transition: string
  count: number
}

export interface SessionReport {
  success: boolean
  insufficient_data: boolean
  message?: string
  valid_observations?: number
  total_observations?: number
  session?: {
    duration_seconds: number
    total_observations: number
    valid_observations: number
    analysis_quality: number
  }
  dominant_emotion?: string
  overall_reaction?: string
  expression_intensity?: { average: number; peak: number }
  emotion_distribution?: EmotionScores
  /** Present only when the session actually captured voice/text data. */
  multimodal?: {
    face: { dominant: string; distribution: EmotionScores }
    voice: {
      dominant: string
      distribution: EmotionScores
      observations: number
      avg_confidence: number
    } | null
    text: {
      dominant: string
      distribution: EmotionScores
      observations: number
      avg_confidence: number
    } | null
    signal_agreement: number | null
    agreement_label: "high" | "moderate" | "low" | null
    transcript_excerpt: string | null
    voice_stress_average: number | null
  } | null
  sentiment?: SentimentScores & { dominant: string }
  distress?: DistressInfo
  emotional_stability?: number
  transitions?: TransitionInfo[]
  key_observations?: string[]
  distress_reasons?: string[]
  reliability_summary?: {
    overall_reliability: number
    high_quality_observations: number
    low_quality_observations: number
    average_face_quality: string
    temporal_consistency: string
  }
}
