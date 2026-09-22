"""Central tunables for the AURA emotion analysis pipeline."""

# Minimum fraction of frame area a face bounding box must occupy to be accepted.
# Lowered slightly from 0.10 so a person sitting a normal arm's-length-plus
# distance from a laptop webcam isn't rejected as "too small" - still well
# above noise-sized false detections.
MIN_FACE_AREA_RATIO = 0.08

# Padding added around a detected face crop before resizing, as a fraction of
# the face bounding box width/height. Raised from 0.18: MediaPipe's box hugs
# the face tightly and often clips the forehead/chin, which throws away real
# eyebrow and jaw evidence the expression fusion (REGION_WEIGHTS) depends on.
FACE_CROP_PADDING = 0.25

# Target size (square) the cropped face is resized to before DeepFace.
FACE_RESIZE_DIM = 224

# Laplacian-variance blur threshold. Frames below this are rejected as too blurry.
BLUR_THRESHOLD = 80.0

# Mean pixel intensity (0-255) below which a frame is considered too dark.
MIN_BRIGHTNESS = 40.0

# MediaPipe face detector confidence threshold.
FACE_DETECTION_CONFIDENCE = 0.5

# Rolling window size (number of recent raw predictions) used for EMA smoothing.
SMOOTHING_WINDOW = 5

# Exponential moving average alpha (weight given to the newest sample).
# Raised from 0.4 so a genuine expression change shows up in 1-2 frames
# instead of being dragged down by several frames of the previous state -
# heavy smoothing was reading as "not detecting" a change that had already
# happened on-camera.
EMA_ALPHA = 0.55

# Below this confidence (percentage points), an observation is treated as low-quality.
CONFIDENCE_LOW = 35.0

# How long (seconds) a session's smoothing state is kept without activity before eviction.
SESSION_TTL_SECONDS = 300

EMOTION_KEYS = ["angry", "disgust", "fear", "happy", "sad", "surprise", "neutral"]

# --- Facial-landmark evidence fusion ---------------------------------------

# Number of recent fused-emotion decisions kept per session for temporal
# consistency, short-reaction detection, and transition tracking (~5-10s at
# a 1-2s analysis cadence).
TEMPORAL_WINDOW = 8

# Number of initial valid frames averaged into a per-session neutral-face
# baseline before landmark evidence starts contributing (accounts for
# naturally downturned lips, resting eye openness, etc. per person).
CALIBRATION_FRAMES = 3

# Fusion weights: how much each evidence source contributes to the final
# emotion decision.
#   deepface   - the pretrained model's own read of this frame.
#   landmarks  - this frame's instantaneous geometric evidence vs. baseline.
#   temporal   - an EMA of that same geometric evidence over recent frames
#                (persistence of the *evidence signal itself*, not a vote for
#                whichever label happened to win earlier - see
#                smoothing.smoothed_support). This is what lets a smile that
#                builds up over 2-3 frames earn real weight without a single
#                odd frame flipping the result, and without creating the
#                opposite bug: an early neutral read entrenching itself.
#   quality    - does not vote for a class directly; it shifts trust from
#                landmarks (quality- and pose-sensitive) back to DeepFace.
# Mirrors the "Happy Evidence" proportions from the spec (deepface 0.50,
# geometry ~0.40 combined, temporal 0.10) fairly closely.
FUSION_WEIGHTS = {
    "deepface": 0.50,
    "landmarks": 0.30,
    "temporal": 0.15,
    "quality": 0.05,
}

# EMA alpha for smoothing landmark-evidence support over recent frames.
# Raised alongside EMA_ALPHA for the same reason - the geometric evidence
# signal should catch up to a real, held expression within a couple of
# frames rather than several.
SUPPORT_EMA_ALPHA = 0.45

# Within the geometry signal, how much each face region contributes. The mouth
# dominates because it carries the most expression information and is the most
# reliably measurable region; "other" covers midface/nose cues, which are the
# weakest signal here and are deliberately not over-weighted.
REGION_WEIGHTS = {
    "mouth": 0.45,
    "eyes": 0.30,
    "brows": 0.20,
    "other": 0.05,
}

# Gain constants converting a normalized geometric delta (measured against the
# user's OWN baseline) into a 0-1 evidence strength. Calibrated so a clearly
# visible expression - not a micro-twitch - reads as strong evidence.
SMILE_GAIN = 6.0
MOUTH_WIDTH_GAIN = 5.0
MOUTH_OPEN_GAIN = 6.0
BROW_GAIN = 7.0
INNER_BROW_GAIN = 7.0
EYE_GAIN = 7.0
LIP_TENSION_GAIN = 8.0

# Frame-to-frame motion gain (raw geometry delta -> 0-1 motion score).
MOTION_GAIN = 8.0

# Head pose. Yaw is the symmetric nose-to-eye-corner ratio from
# facial_features.head_pose (0.0 = frontal), NOT a face-oval offset.
# Landmark trust is full below the soft threshold and ramps linearly to zero
# at the max - a soft ramp rather than a hard cutoff, because a hard gate lets
# one slightly-off pose estimate silently discard otherwise-good evidence.
# ~0.10 corresponds to a mild turn, ~0.30 to a strong one.
YAW_SOFT_THRESHOLD = 0.12
MAX_YAW_RATIO = 0.32
PITCH_SOFT_THRESHOLD = 0.18
MAX_PITCH_DEVIATION = 0.45

# Minimum in-plane tilt (degrees) worth paying a de-rotation pass for.
ALIGN_MIN_ROLL_DEGREES = 3.0

# An eye is treated as closed below this fraction of the user's OWN baseline
# eye openness. Relative, not absolute: resting aperture varies widely between
# people and an absolute EAR threshold misreads some faces as mid-blink.
BLINK_CLOSED_FRACTION = 0.55

# CLAHE lighting normalization is applied only OUTSIDE this brightness band -
# a well-exposed crop is left untouched. Sharpening is deliberately never
# applied on the inference path (see face_preprocessing.normalize_lighting).
CLAHE_MIN_BRIGHTNESS = 70.0
CLAHE_MAX_BRIGHTNESS = 185.0
CLAHE_CLIP_LIMIT = 2.0
CLAHE_TILE_GRID = 8

# Expression-intensity bands -> "Overall Reaction" label.
REACTION_MINIMAL_MAX = 20
REACTION_MILD_MAX = 40
REACTION_MODERATE_MAX = 65

# Expression-event detection thresholds (on 0-1 evidence signals).
EVENT_SMILE_ON = 0.45
EVENT_SMILE_OFF = 0.25
EVENT_GENERIC_ON = 0.45

# Below this fused confidence the result is reported as "uncertain" rather
# than naming an emotion the evidence does not support.
MIN_CONFIDENCE_FOR_LABEL = 22.0

# =========================================================================
# VOICE / SPEECH / TEXT ANALYSIS
#
# These are entirely separate from the facial pipeline above. The facial
# analysis does not read any of them, so voice can be enabled, disabled or
# fail to install without affecting the DeepFace video path at all.
# =========================================================================

# --- Audio quality gating ---
AUDIO_MIN_DURATION = 1.0          # seconds; shorter windows are not analysed
AUDIO_SILENCE_RMS = 0.004         # below this the window is treated as silence
AUDIO_TARGET_RMS = 0.06           # reference level for the 0-1 energy scale
AUDIO_GOOD_SNR_DB = 20.0          # estimated SNR treated as "good"
AUDIO_MIN_QUALITY_SCORE = 25.0    # below this, voice emotion is Uncertain

# --- Voice activity detection ---
VAD_AGGRESSIVENESS = 2            # webrtcvad 0-3; 2 balances noise vs. recall
VAD_MIN_SPEECH_RATIO = 0.15       # fraction of voiced frames to call it speech

# --- Acoustic features ---
PITCH_FMIN = 65.0
PITCH_FMAX = 350.0
N_MFCC = 13
PAUSE_MIN_SECONDS = 0.35          # gap counted as a deliberate pause

# --- Speech-to-text (ElevenLabs) ---
# Hosted API - no local model size/device/compute-type tuning applies.
# Override via the ELEVENLABS_API_KEY / model env vars documented in .env.example.
ELEVENLABS_STT_MODEL = "scribe_v2"
ELEVENLABS_TIMEOUT_SECONDS = 30.0
STT_SAMPLE_RATE = 16000

# --- Real-time voice windows ---
# Partial windows are short so text appears while the person is still
# speaking. Below ~1s Whisper has too little context and accuracy collapses.
VOICE_PARTIAL_WINDOW_SECONDS = 2.0
VOICE_PARTIAL_HOP_MS = 700
# An utterance is considered finished after this much continuous silence,
# which triggers the accurate final pass.
VOICE_UTTERANCE_SILENCE_MS = 700
# Hard cap so a monologue still gets periodic final passes.
VOICE_MAX_UTTERANCE_SECONDS = 20.0

# --- Transcript validation ---
# Segment confidence (derived from avg_logprob) below which a segment is shown
# as UNCERTAIN and withheld from text-emotion analysis rather than corrected.
SEGMENT_MIN_CONFIDENCE = 0.45
# Detected-language probability below which the transcript is flagged unreliable.
LANGUAGE_MIN_PROBABILITY = 0.60
# Word count at which a transcript is considered a full-strength emotion input.
TRANSCRIPT_TARGET_WORDS = 12

# --- Pretrained model ids ---
# This text model emits exactly the seven Ekman labels AURA already uses, so
# no lossy label remapping is needed on the text path.
TEXT_EMOTION_MODEL = "j-hartmann/emotion-english-distilroberta-base"
TEXT_EMOTION_LANGUAGES = ("en",)  # honestly reported; not silently translated
VOICE_EMOTION_MODEL = "superb/wav2vec2-base-superb-er"

# The voice model's own label set differs from AURA's seven emotions, so the
# mapping is explicit and documented rather than guessed. Labels this model
# cannot express (surprise, disgust) are left absent instead of invented.
VOICE_EMOTION_LABEL_MAP = {
    "hap": "happy",
    "happy": "happy",
    "sad": "sad",
    "ang": "angry",
    "angry": "angry",
    "neu": "neutral",
    "neutral": "neutral",
    "fea": "fear",
    "fear": "fear",
    "dis": "disgust",
    "disgust": "disgust",
    "sur": "surprise",
    "surprise": "surprise",
}

# --- Multimodal fusion ---
# Base weights when all three modalities are present. Renormalized
# dynamically over whichever modalities are actually available, then further
# scaled by each modality's own confidence and signal quality.
MULTIMODAL_WEIGHTS = {
    "face": 0.40,
    "voice": 0.35,
    "text": 0.25,
}

# How strongly a modality's confidence/quality modulates its weight. At 0.0
# the base weights are used verbatim; at 1.0 a zero-confidence modality is
# ignored entirely. Keeps a poor signal from outvoting a strong one.
MODALITY_QUALITY_INFLUENCE = 0.6

# Rolling multimodal history (seconds) for persistence and transitions.
MULTIMODAL_WINDOW_SECONDS = 30

# Distress contribution weights (see distress_engine.build_report).
DISTRESS_WEIGHTS = {
    "sustained_negative": 0.40,
    "voice_negative": 0.20,
    "text_negative": 0.15,
    "persistence": 0.15,
    "instability": 0.10,
}

SENTIMENT_MAP = {
    "happy": {"positive": 0.9, "neutral": 0.1, "negative": 0.0},
    "surprise": {"positive": 0.5, "neutral": 0.4, "negative": 0.1},
    "neutral": {"positive": 0.1, "neutral": 0.8, "negative": 0.1},
    "sad": {"positive": 0.0, "neutral": 0.2, "negative": 0.8},
    "angry": {"positive": 0.0, "neutral": 0.1, "negative": 0.9},
    "fear": {"positive": 0.0, "neutral": 0.2, "negative": 0.8},
    "disgust": {"positive": 0.0, "neutral": 0.1, "negative": 0.9},
}
