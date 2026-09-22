"""Real-time voice frame: parallelism, synchronization and honest absence.

Run (from backend/):
    C:\\Users\\Admin\\aura-backend-venv\\Scripts\\python.exe -m tests.test_voice_realtime

Offline - calls the pipeline directly, no server needed.

These tests deliberately do NOT assert a particular emotion. Synthetic audio
has no emotional content, so an assertion about which label appears would be
asserting a fabrication. What is checked is structural: that absence is
reported as absence, that a single feature cannot produce a label, that the
two branches actually overlap, and that the schema rejects malformed frames.
"""
import io
import math
import struct
import sys
import time

import numpy as np

from app import config, voice_realtime, voice_signal
from app.voice_frame import Feature, VoiceAnalysisFrame, VoiceSignal, WindowSpan

results = []


def check(name, ok, detail=""):
    results.append(("PASS" if ok else "FAIL", name, detail))
    print(f"  {'ok ' if ok else 'BAD'} {name}" + (f"  [{detail}]" if detail else ""))


def wav_bytes(samples: np.ndarray, rate: int = 16000) -> bytes:
    """Encodes float32 mono to 16-bit PCM WAV - the format the browser sends."""
    pcm = np.clip(samples, -1.0, 1.0)
    pcm = (pcm * 32767).astype("<i2").tobytes()
    hdr = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt "
    hdr += struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
    hdr += b"data" + struct.pack("<I", len(pcm))
    return hdr + pcm


def silence(seconds=3.0, rate=16000):
    return np.zeros(int(seconds * rate), dtype=np.float32)


def speechlike(seconds=3.0, rate=16000, f0=140.0, amp=0.25, pause_at=None):
    """A voiced buzz with formant-ish harmonics and an amplitude envelope.

    Not real speech - it is only used to exercise the measurement code paths
    and the VAD. No emotional claim is made about it anywhere in this file.
    """
    t = np.linspace(0, seconds, int(seconds * rate), endpoint=False)
    sig = np.zeros_like(t)
    for harmonic, weight in ((1, 1.0), (2, 0.5), (3, 0.28), (4, 0.15)):
        sig += weight * np.sin(2 * math.pi * f0 * harmonic * t)
    # Syllable-rate envelope so onset counting has something to find.
    env = 0.5 + 0.5 * np.sin(2 * math.pi * 4.0 * t)
    sig = sig * env
    if pause_at:
        a, b = pause_at
        sig[int(a * rate) : int(b * rate)] = 0.0
    sig = sig / (np.max(np.abs(sig)) + 1e-9) * amp
    return sig.astype(np.float32)


def main() -> int:
    print("=" * 78)
    print("REAL-TIME VOICE FRAME")
    print("=" * 78)

    sid = f"rt-test-{int(time.time())}"

    # --- 1. Schema refuses to carry a finding without an analysis ---------
    print("\n[1] Schema forbids fabricated findings")
    print("-" * 78)
    span = WindowSpan(
        session_id="s", window_start=0.0, window_end=3.0, timestamp=1, duration=3.0
    )
    try:
        VoiceAnalysisFrame(
            window=span,
            analysis_used=False,
            message="no speech",
            voice_signal=VoiceSignal(observed="Elevated vocal activation", confidence=80.0),
        )
        check("signal on an unanalysed frame is rejected", False, "accepted")
    except Exception:
        check("signal on an unanalysed frame is rejected", True)

    try:
        VoiceAnalysisFrame(window=span, analysis_used=False, message="x", confidence=55.0)
        check("confidence on an unanalysed frame is rejected", False, "accepted")
    except Exception:
        check("confidence on an unanalysed frame is rejected", True)

    try:
        VoiceAnalysisFrame(window=span, analysis_used=False)
        check("unanalysed frame must state a reason", False, "accepted")
    except Exception:
        check("unanalysed frame must state a reason", True)

    try:
        Feature(available=True)
        check("empty-but-available feature is rejected", False, "accepted")
    except Exception:
        check("empty-but-available feature is rejected", True)

    try:
        VoiceSignal(observed="x", confidence=50.0, emotion="sad")
        check("named emotion without confidence is rejected", False, "accepted")
    except Exception:
        check("named emotion without confidence is rejected", True)

    try:
        WindowSpan(session_id="s", window_start=5.0, window_end=1.0, timestamp=1, duration=1.0)
        check("reversed window is rejected", False, "accepted")
    except Exception:
        check("reversed window is rejected", True)

    # --- 2. Silence produces no finding -----------------------------------
    print("\n[2] Silence is reported as absence, not as an emotion")
    print("-" * 78)
    f = voice_realtime.analyze_frame(wav_bytes(silence()), sid, 0.0, 3.0)
    print(f"      analysis_used={f.analysis_used} msg={f.message}")
    check("silence -> analysis_used False", f.analysis_used is False)
    check("silence -> no voice signal", f.voice_signal is None)
    check("silence -> zero confidence", f.confidence == 0.0)
    check("silence -> states a reason", bool(f.message))
    check("silence -> no fabricated transcript", f.transcript.text == "")

    # --- 3. Window synchronization ----------------------------------------
    print("\n[3] Every frame carries its window")
    print("-" * 78)
    f = voice_realtime.analyze_frame(wav_bytes(speechlike()), sid, 5.0, 8.0)
    print(f"      session={f.window.session_id} {f.window.window_start}-{f.window.window_end}s")
    check("session_id echoed", f.window.session_id == sid)
    check("window_start preserved", f.window.window_start == 5.0)
    check("window_end preserved", f.window.window_end == 8.0)
    check("duration derived from the window", abs(f.window.duration - 3.0) < 0.01)
    check("timestamp present", f.window.timestamp > 0)

    # --- 4. Branches actually run in parallel ------------------------------
    print("\n[4] STT and acoustic branches overlap")
    print("-" * 78)
    # is_final=True so the tone model runs and both branches are substantial;
    # on a partial window the acoustic branch is ~50ms and the overlap it can
    # save is correspondingly tiny.
    f = voice_realtime.analyze_frame(wav_bytes(speechlike(4.0)), sid, 8.0, 12.0, is_final=True)
    lat = f.latency
    print(f"      features={lat.features_ms:.0f}ms tone={lat.tone_ms:.0f}ms "
          f"transcribe={lat.transcribe_ms:.0f}ms total={lat.total_ms:.0f}ms "
          f"parallel={lat.parallel} saved={lat.overlap_saved_ms:.0f}ms")
    if f.analysis_used:
        check("both branches reported timings",
              lat.features_ms > 0 and lat.transcribe_ms > 0)
        check("branches were dispatched concurrently", lat.parallel is True)
        check("overlap saved measurable wall time",
              lat.overlap_saved_ms > 50, f"{lat.overlap_saved_ms:.0f}ms")
        check("total is less than the sum of both branches",
              lat.total_ms < lat.features_ms + lat.tone_ms + lat.transcribe_ms,
              f"{lat.total_ms:.0f} vs {lat.features_ms + lat.tone_ms + lat.transcribe_ms:.0f}")
    else:
        check("speech-like audio passed the VAD gate", False, f.message or "")

    # A partial window must skip the expensive tone model entirely.
    p = voice_realtime.analyze_frame(wav_bytes(speechlike(2.0)), sid, 12.0, 14.0, is_final=False)
    print(f"      partial: tone={p.latency.tone_ms:.0f}ms total={p.latency.total_ms:.0f}ms")
    check("partial window skips the tone model", p.latency.tone_ms == 0.0)
    if p.analysis_used and p.voice_signal:
        check("partial window names no emotion", p.voice_signal.emotion is None)
        check("partial window still reports an observation", bool(p.voice_signal.observed))

    # --- 5. No label from a single feature ---------------------------------
    print("\n[5] A single feature cannot produce a label")
    print("-" * 78)
    voice_signal.reset_session("solo")
    # Feed one measured feature repeatedly past the baseline window.
    for _ in range(8):
        observed, conf, contributing, _ = voice_signal.derive("solo", {"pitch": 0.9})
    print(f"      observed='{observed}' contributing={contributing}")
    check("one feature never yields an activation label",
          observed != "Elevated vocal activation", observed)

    voice_signal.reset_session("multi")
    for _ in range(3):
        voice_signal.derive("multi", {"pitch": 0.3, "energy": 0.3,
                                      "speech_rate": 0.3, "pitch_variation": 0.3})
    for _ in range(6):
        observed_m, conf_m, contributing_m, _ = voice_signal.derive(
            "multi", {"pitch": 0.9, "energy": 0.9, "speech_rate": 0.9, "pitch_variation": 0.9}
        )
    print(f"      observed='{observed_m}' contributing={contributing_m} conf={conf_m}")
    check("agreeing features CAN yield an observation",
          len(contributing_m) >= 2, str(contributing_m))
    check("observation describes the signal, not the person",
          not any(w in observed_m.lower() for w in ("stressed", "anxious", "angry", "sad")),
          observed_m)

    # --- 6. Baseline calibration is reported, not skipped -------------------
    print("\n[6] Baseline calibration is explicit")
    print("-" * 78)
    voice_signal.reset_session("fresh")
    observed_f, conf_f, _, _ = voice_signal.derive(
        "fresh", {"pitch": 0.5, "energy": 0.5, "speech_rate": 0.5}
    )
    print(f"      first window -> '{observed_f}' conf={conf_f}")
    check("first window says it is still calibrating", "baseline" in observed_f.lower())
    check("calibrating confidence stays low", conf_f <= 25.0, str(conf_f))
    check("never defaults to Neutral",
          "neutral" not in observed_f.lower())

    # --- 7. Session isolation ----------------------------------------------
    print("\n[7] Sessions do not share a baseline")
    print("-" * 78)
    voice_signal.reset_session("a1")
    for _ in range(6):
        voice_signal.derive("a1", {"pitch": 0.2, "energy": 0.2, "speech_rate": 0.2})
    before = voice_signal.session_window_count("a1")
    voice_signal.reset_session("a1")
    after = voice_signal.session_window_count("a1")
    check("reset clears a session's baseline", before > 0 and after == 0, f"{before}->{after}")

    # --- 8. Unmeasured features are absent, not zero -----------------------
    print("\n[8] Absent measurements are not reported as zero")
    print("-" * 78)
    f = voice_realtime.analyze_frame(wav_bytes(speechlike(3.0)), sid, 15.0, 18.0, is_final=True)
    if f.analysis_used:
        unavailable = [n for n, feat in f.prosody if isinstance(feat, Feature) and not feat.available]
        for name, feat in f.prosody:
            if isinstance(feat, Feature) and not feat.available:
                if feat.raw is not None or feat.normalized is not None:
                    check("unavailable features carry no value", False, name)
                    break
        else:
            check("unavailable features carry no value", True, f"{len(unavailable)} unavailable")
        measured = f.prosody.measured()
        print(f"      measured: {', '.join(measured)}")
        check("at least pitch/energy/timing were measured", len(measured) >= 3, str(len(measured)))
        check("normalized bars are within 0-1",
              all(0.0 <= feat.normalized <= 1.0
                  for _, feat in f.prosody
                  if isinstance(feat, Feature) and feat.normalized is not None))
    else:
        check("frame analysed for feature inspection", False, f.message or "")

    # --- 9. Observation and interpretation stay separate -------------------
    print("\n[9] Observation is separate from interpretation")
    print("-" * 78)
    if f.analysis_used and f.voice_signal:
        vs = f.voice_signal
        print(f"      observed='{vs.observed}' conf={vs.confidence}")
        print(f"      emotion={vs.emotion} conf={vs.emotion_confidence}")
        check("observed field is populated", bool(vs.observed))
        check("interpretation note travels with the data",
              "not a diagnosis" in vs.interpretation_note.lower())
        check("emotion is absent or paired with a confidence",
              vs.emotion is None or vs.emotion_confidence is not None)
        check("emotion is never silently neutral",
              vs.emotion != "neutral" or (vs.emotion_confidence or 0) >= 35.0)
    else:
        check("frame carried a voice signal", False)

    # --- 10. Corrupt input degrades that window only -----------------------
    print("\n[10] Bad input fails one window, not the server")
    print("-" * 78)
    f = voice_realtime.analyze_frame(b"not audio at all", sid, 15.0, 18.0)
    check("garbage audio -> error, not exception", f.analysis_used is False)
    check("garbage audio -> error stated", bool(f.error))
    f = voice_realtime.analyze_frame(b"", sid, 18.0, 21.0)
    check("empty upload -> error stated", bool(f.error))

    print("\n" + "=" * 78)
    failures = [x for x in results if x[0] == "FAIL"]
    print(f"RESULT: {len(results) - len(failures)}/{len(results)} checks passed")
    if failures:
        print("\nFAILURES:")
        for _, name, d in failures:
            print(f"  FAIL  {name}  [{d}]")
    print("=" * 78)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
