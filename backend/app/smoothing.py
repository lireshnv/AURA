"""Per-session temporal state for the analysis pipeline.

Holds, per session id:
  * an EMA of DeepFace's probability distribution
  * an EMA of the geometric evidence support map
  * the user's personal neutral-face baseline (numeric geometry only - never
    an image)
  * the previous frame's geometry, for frame-to-frame motion
  * recent fused decisions, for temporal consistency / transitions / brief
    reaction detection
  * previous expression-signal levels, for event edge detection

All state is keyed by session id and evicted after SESSION_TTL_SECONDS, so a
new session never inherits a previous one's baseline or history.
"""
import time
from collections import deque
from threading import Lock
from typing import Dict, List, Optional, Tuple

from . import config
from .facial_features import BASELINE_FIELDS, FaceGeometry

_ZERO_SCORES: Dict[str, float] = {k: 0.0 for k in config.EMOTION_KEYS}

_EVENT_SIGNALS = {
    "smile": ("SMILE_STARTED", "SMILE_ENDED", "SMILE_SUSTAINED"),
    "brow_raise": ("BROW_RAISE", None, None),
    "brow_lower": ("BROW_COMPRESSION", None, None),
    "mouth_open": ("MOUTH_OPENING", "MOUTH_CLOSING", None),
    "eye_widening": ("EYE_OPENING", None, None),
    "eye_narrowing": ("EYE_NARROWING", None, None),
}


def _geometry_to_dict(g: FaceGeometry) -> Dict[str, float]:
    return {f: getattr(g, f) for f in BASELINE_FIELDS}


def _average_geometry(samples: List[Dict[str, float]]) -> Dict[str, float]:
    return {f: sum(s[f] for s in samples) / len(samples) for f in BASELINE_FIELDS}


class _SessionState:
    __slots__ = (
        "smoothed",
        "last_seen",
        "sample_count",
        "dominant_history",
        "baseline_samples",
        "baseline",
        "prev_geometry",
        "support_ema",
        "support_sample_count",
        "prev_signals",
        "smile_active_frames",
        "baseline_pitch_samples",
        "baseline_pitch",
        "eye_closed",
        "blink_count",
        "blink_window_start",
    )

    def __init__(self):
        self.smoothed = dict(_ZERO_SCORES)
        self.last_seen = time.time()
        self.sample_count = 0
        self.dominant_history: deque = deque(maxlen=config.TEMPORAL_WINDOW)
        self.baseline_samples: List[Dict[str, float]] = []
        self.baseline: Optional[Dict[str, float]] = None
        self.prev_geometry: Optional[Dict[str, float]] = None
        self.support_ema: Dict[str, float] = dict(_ZERO_SCORES)
        self.support_sample_count = 0
        self.prev_signals: Dict[str, float] = {}
        self.smile_active_frames = 0
        # Head pitch is tracked separately from the expression baseline: it
        # describes where the head points, not what the face expresses, so it
        # must not become an expression delta. It is kept only so pitch can be
        # judged relative to this user's own calibrated head position.
        self.baseline_pitch_samples: List[float] = []
        self.baseline_pitch: Optional[float] = None
        self.eye_closed = False
        self.blink_count = 0
        self.blink_window_start = time.time()


class SessionStore:
    """In-memory per-session state. Single-process dev deployment only."""

    def __init__(self):
        self._sessions: Dict[str, _SessionState] = {}
        self._lock = Lock()

    def _evict_stale(self):
        cutoff = time.time() - config.SESSION_TTL_SECONDS
        for sid in [s for s, st in self._sessions.items() if st.last_seen < cutoff]:
            del self._sessions[sid]

    def update(self, session_id: str, raw_scores: Dict[str, float]) -> Dict[str, float]:
        """EMA-smooths DeepFace's own distribution."""
        with self._lock:
            self._evict_stale()
            state = self._sessions.setdefault(session_id, _SessionState())
            state.last_seen = time.time()

            if state.sample_count == 0:
                state.smoothed = dict(raw_scores)
            else:
                alpha = config.EMA_ALPHA
                state.smoothed = {
                    k: alpha * raw_scores.get(k, 0.0) + (1 - alpha) * state.smoothed.get(k, 0.0)
                    for k in config.EMOTION_KEYS
                }
            state.sample_count += 1
            return dict(state.smoothed)

    def observation_count(self, session_id: str) -> int:
        with self._lock:
            state = self._sessions.setdefault(session_id, _SessionState())
            return state.sample_count

    def peek_last_dominant(self, session_id: str) -> Optional[str]:
        with self._lock:
            state = self._sessions.setdefault(session_id, _SessionState())
            return state.dominant_history[-1] if state.dominant_history else None

    def record_dominant(self, session_id: str, dominant: str) -> float:
        """Appends the fused decision; returns temporal consistency (0-100)."""
        with self._lock:
            state = self._sessions.setdefault(session_id, _SessionState())
            state.dominant_history.append(dominant)
            history = state.dominant_history
            matches = sum(1 for d in history if d == dominant)
            return round(matches / len(history) * 100, 1)

    def session_dominant(self, session_id: str) -> Optional[str]:
        """The most persistent emotion across the recent window, which can
        legitimately differ from the current frame's - a mostly-neutral session
        with one genuine smile should report both, not collapse to one."""
        with self._lock:
            state = self._sessions.setdefault(session_id, _SessionState())
            if not state.dominant_history:
                return None
            counts: Dict[str, int] = {}
            for d in state.dominant_history:
                counts[d] = counts.get(d, 0) + 1
            return max(counts, key=counts.get)

    def update_support_ema(
        self, session_id: str, support: Optional[Dict[str, float]]
    ) -> Dict[str, float]:
        """EMA-smooths the geometric evidence map.

        When this frame has no support (calibrating / no landmarks / untrusted
        pose) the EMA is left untouched: we have no new evidence, which is not
        the same as evidence for any particular emotion.
        """
        with self._lock:
            state = self._sessions.setdefault(session_id, _SessionState())
            if support is not None:
                if state.support_sample_count == 0:
                    state.support_ema = dict(support)
                else:
                    alpha = config.SUPPORT_EMA_ALPHA
                    state.support_ema = {
                        k: alpha * support.get(k, 0.0) + (1 - alpha) * state.support_ema.get(k, 0.0)
                        for k in config.EMOTION_KEYS
                    }
                state.support_sample_count += 1
            return dict(state.support_ema)

    def recent_reaction(self, session_id: str, current_dominant: str) -> Optional[str]:
        """A brief expression that has not become the prevailing trend, so a
        1-2 second smile is still surfaced instead of being smoothed away."""
        with self._lock:
            state = self._sessions.setdefault(session_id, _SessionState())
            history = list(state.dominant_history)
            if len(history) < 3:
                return None
            counts: Dict[str, int] = {}
            for d in history:
                counts[d] = counts.get(d, 0) + 1
            persistent = max(counts, key=counts.get)
            if current_dominant != persistent and counts.get(current_dominant, 0) <= 2:
                return f"{persistent} -> {current_dominant}"
            return None

    def baseline_or_collect(
        self, session_id: str, geometry: FaceGeometry
    ) -> Tuple[Optional[Dict[str, float]], bool]:
        """Returns (baseline, calibrating).

        During the first CALIBRATION_FRAMES valid frames the sample is folded
        into the personal baseline and landmark evidence is withheld - measuring
        a face against itself is not evidence of anything.
        """
        with self._lock:
            state = self._sessions.setdefault(session_id, _SessionState())
            if state.baseline is not None:
                return state.baseline, False

            state.baseline_samples.append(_geometry_to_dict(geometry))
            state.baseline_pitch_samples.append(geometry.pitch_ratio)
            if len(state.baseline_samples) >= config.CALIBRATION_FRAMES:
                state.baseline = _average_geometry(state.baseline_samples)
                state.baseline_pitch = sum(state.baseline_pitch_samples) / len(
                    state.baseline_pitch_samples
                )
                return state.baseline, False
            return None, True

    def update_blink(
        self, session_id: str, eye_openness: float, baseline_openness: Optional[float]
    ) -> Dict[str, object]:
        """Tracks blinks as closed/open transitions and returns blinks/minute.

        The closure threshold is a FRACTION of this user's own baseline eye
        openness, not an absolute EAR value - resting eye aperture varies a lot
        between people, and an absolute threshold would read some faces as
        permanently mid-blink.

        Important caveat carried in the return value: at a ~1-2 s analysis
        cadence the sampling is far slower than an actual blink (~0.1-0.4 s),
        so most blinks are missed entirely. The rate is therefore reported as
        a coarse, sampling-limited indicator - never as a clinical blink rate.
        """
        with self._lock:
            state = self._sessions.setdefault(session_id, _SessionState())

            detected = False
            if baseline_openness and baseline_openness > 1e-6:
                closed_now = eye_openness < baseline_openness * config.BLINK_CLOSED_FRACTION
                if closed_now and not state.eye_closed:
                    state.blink_count += 1
                    detected = True
                state.eye_closed = closed_now

            elapsed = max(1e-6, time.time() - state.blink_window_start)
            per_minute = state.blink_count / elapsed * 60.0

            return {
                "blink_count": state.blink_count,
                "blinks_per_minute": round(per_minute, 1),
                "eye_currently_closed": state.eye_closed,
                "blink_detected_this_frame": detected,
                "sampling_limited": True,
                "observed_seconds": round(elapsed, 1),
            }

    def baseline_pitch(self, session_id: str) -> Optional[float]:
        """This user's calibrated resting head pitch, if calibration finished."""
        with self._lock:
            state = self._sessions.setdefault(session_id, _SessionState())
            return state.baseline_pitch

    def swap_prev_geometry(
        self, session_id: str, geometry: FaceGeometry
    ) -> Optional[Dict[str, float]]:
        """Returns the previous valid frame's geometry and stores this one."""
        with self._lock:
            state = self._sessions.setdefault(session_id, _SessionState())
            current = _geometry_to_dict(geometry)
            prev = state.prev_geometry
            state.prev_geometry = current
            return prev

    def detect_events(self, session_id: str, signals: Optional[Dict[str, float]]) -> List[str]:
        """Edge-detects expression events with hysteresis.

        Hysteresis (separate on/off thresholds for smiles) stops a signal
        hovering at the boundary from emitting START/END on alternating frames.
        """
        if signals is None:
            return []
        events: List[str] = []
        with self._lock:
            state = self._sessions.setdefault(session_id, _SessionState())
            prev = state.prev_signals

            smile_now = signals.get("smile", 0.0)
            smile_before = prev.get("smile", 0.0)
            if smile_now >= config.EVENT_SMILE_ON:
                if smile_before < config.EVENT_SMILE_ON:
                    events.append("SMILE_STARTED")
                    state.smile_active_frames = 1
                else:
                    state.smile_active_frames += 1
                    if state.smile_active_frames >= 2:
                        events.append("SMILE_SUSTAINED")
            elif smile_now < config.EVENT_SMILE_OFF and smile_before >= config.EVENT_SMILE_ON:
                events.append("SMILE_ENDED")
                state.smile_active_frames = 0

            for signal, (on_event, off_event, _) in _EVENT_SIGNALS.items():
                if signal == "smile":
                    continue
                now = signals.get(signal, 0.0)
                before = prev.get(signal, 0.0)
                if on_event and now >= config.EVENT_GENERIC_ON > before:
                    events.append(on_event)
                elif off_event and before >= config.EVENT_GENERIC_ON > now:
                    events.append(off_event)

            state.prev_signals = dict(signals)
        return events


store = SessionStore()
