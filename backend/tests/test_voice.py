"""Tests for the voice / speech / text / multimodal modules.

Run (from backend/):
    C:\\Users\\Admin\\aura-backend-venv\\Scripts\\python.exe -m tests.test_voice

Note on audio fixtures: this generates SYNTHETIC audio (tones, noise, silence).
That is sufficient and appropriate for what these tests assert - the quality
gate, the VAD, the acoustic feature extraction and the fusion maths. It is NOT
a test of speech-emotion accuracy, and this file does not claim to be: a tone
is not speech, so Whisper and the voice-emotion model are exercised only for
"does the plumbing work and does it degrade honestly", never for correctness
of their predictions. Real accuracy testing needs labelled human speech.
"""
import io
import sys
import wave

import numpy as np

from app import audio_features, config, multimodal_fusion, text_emotion, voice_service

SR = 16000
results = []


def check(name, condition, detail=""):
    results.append(("PASS" if condition else "FAIL", name, detail))
    print(f"  {'ok ' if condition else 'BAD'} {name}" + (f"  [{detail}]" if detail else ""))


def make_wav(samples: np.ndarray, sr: int = SR) -> bytes:
    """16-bit mono PCM WAV, matching what the browser uploads."""
    pcm = np.clip(samples * 32767, -32768, 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def silence(seconds=3.0):
    return np.zeros(int(SR * seconds), dtype=np.float32)


def tone(seconds=3.0, freq=180.0, amp=0.25):
    t = np.linspace(0, seconds, int(SR * seconds), endpoint=False)
    # Harmonics + vibrato: voice-like enough to exercise pitch tracking.
    sig = amp * (
        np.sin(2 * np.pi * freq * t)
        + 0.5 * np.sin(2 * np.pi * freq * 2 * t)
        + 0.25 * np.sin(2 * np.pi * freq * 3 * t)
    )
    sig *= 1.0 + 0.05 * np.sin(2 * np.pi * 5 * t)
    return sig.astype(np.float32)


def noise(seconds=3.0, amp=0.02):
    return (np.random.randn(int(SR * seconds)) * amp).astype(np.float32)


def main() -> int:
    print("=" * 78)
    print("AURA VOICE / SPEECH / TEXT / MULTIMODAL TESTS")
    print("=" * 78)

    print("\n[0] Capabilities in this environment")
    print("-" * 78)
    caps = voice_service.capability_report()
    for k, v in caps.items():
        print(f"      {k:20s} {v}")

    # --- 1. Decode ---------------------------------------------------------
    print("\n[1] Audio decoding")
    print("-" * 78)
    decoded = audio_features.decode_wav(make_wav(tone()))
    check("16 kHz mono WAV decodes", decoded is not None)
    if decoded:
        check("sample rate is 16 kHz", decoded.sample_rate == 16000, str(decoded.sample_rate))
        check("~3 s of samples", abs(len(decoded.samples) / SR - 3.0) < 0.05,
              f"{len(decoded.samples)/SR:.2f}s")
    check("garbage bytes rejected", audio_features.decode_wav(b"not audio at all") is None)
    check("empty bytes rejected", audio_features.decode_wav(b"") is None)

    # Resampling path: 44.1 kHz in, 16 kHz out.
    hi = audio_features.decode_wav(make_wav(tone(2.0), sr=44100))
    check("44.1 kHz resampled to 16 kHz", hi is not None and hi.sample_rate == 16000)

    # --- 2. Quality gate ---------------------------------------------------
    print("\n[2] Audio quality gate")
    print("-" * 78)
    q_tone = audio_features.assess_quality(audio_features.decode_wav(make_wav(tone())))
    q_sil = audio_features.assess_quality(audio_features.decode_wav(make_wav(silence())))
    q_short = audio_features.assess_quality(audio_features.decode_wav(make_wav(tone(0.4))))
    print(f"      tone   : score={q_tone.score:5.1f} label={q_tone.label:10s} acceptable={q_tone.acceptable}")
    print(f"      silence: score={q_sil.score:5.1f} label={q_sil.label:10s} acceptable={q_sil.acceptable}")
    print(f"      0.4s   : score={q_short.score:5.1f} label={q_short.label:10s} acceptable={q_short.acceptable}")
    check("clear tone accepted", q_tone.acceptable)
    check("silence rejected", not q_sil.acceptable)
    check("too-short window rejected", not q_short.acceptable)

    # --- 3. VAD ------------------------------------------------------------
    print("\n[3] Voice activity detection")
    print("-" * 78)
    for label, sig, expect in (
        ("silence", silence(), False),
        ("low noise", noise(3.0, 0.005), False),
    ):
        d = audio_features.decode_wav(make_wav(sig))
        detected, ratio, method = audio_features.detect_speech(d)
        print(f"      {label:10s} detected={detected} ratio={ratio:.2f} method={method}")
        check(f"VAD on {label} -> {detected}", detected == expect, f"ratio={ratio}")

    d_tone = audio_features.decode_wav(make_wav(tone()))
    detected, ratio, method = audio_features.detect_speech(d_tone)
    print(f"      {'tone':10s} detected={detected} ratio={ratio:.2f} method={method}")
    print("      (a pure tone is not speech; either answer is acceptable, recorded only)")

    # --- 4. Acoustic features ---------------------------------------------
    print("\n[4] Acoustic features")
    print("-" * 78)
    feats = audio_features.extract_acoustic_features(d_tone)
    check("features available", feats.available)
    if feats.available:
        print(f"      pitch mean={feats.pitch_mean_hz} Hz  std={feats.pitch_std_hz}"
              f"  variability={feats.pitch_variability}")
        print(f"      energy mean={feats.energy_mean}  normalized={feats.energy_normalized}")
        print(f"      centroid={feats.spectral_centroid} Hz  zcr={feats.zero_crossing_rate}")
        print(f"      mfcc count={len(feats.mfcc_mean)}")
        # 180 Hz fundamental was synthesized; YIN should land near it.
        check("pitch tracked near synthesized 180 Hz",
              120 < feats.pitch_mean_hz < 260, f"{feats.pitch_mean_hz} Hz")
        check("MFCC count matches config", len(feats.mfcc_mean) == config.N_MFCC,
              str(len(feats.mfcc_mean)))
        check("energy is positive", feats.energy_mean > 0)

    # --- 5. Speech timing --------------------------------------------------
    print("\n[5] Speech timing from segment timestamps")
    print("-" * 78)
    segs = [
        {"start": 0.0, "end": 1.2, "text": "hello there friend"},
        {"start": 2.0, "end": 3.0, "text": "how are you"},
    ]
    timing = audio_features.speech_timing(segs, 4.0)
    print(f"      {timing}")
    check("words per second computed", timing["words_per_second"] > 0)
    check("pause detected between segments", timing["pause_count"] >= 1)
    empty = audio_features.speech_timing([], 4.0)
    check("no segments -> zeroed timing, not invented", empty["words_per_second"] == 0.0)

    # --- 6. Text emotion (real model) -------------------------------------
    print("\n[6] Text emotion model")
    print("-" * 78)
    if not text_emotion.is_available():
        print("      transformers/torch unavailable - skipping (reported honestly)")
        check("text emotion reports unavailable rather than faking",
              text_emotion.analyze_text("hello").available is False)
    else:
        cases = [
            ("I am really happy to see you today!", "happy"),
            ("I feel so sad and hopeless about everything.", "sad"),
            ("I am furious, this is completely unacceptable!", "angry"),
            ("I'm terrified about what might happen tomorrow.", "fear"),
            ("The meeting is scheduled for three o'clock.", "neutral"),
        ]
        for text, expected in cases:
            r = text_emotion.analyze_text(text, language="en")
            if not r.available:
                check(f"text: {text[:30]}", False, r.error or "unavailable")
                continue
            top = sorted(r.scores.items(), key=lambda kv: kv[1], reverse=True)[:2]
            top_s = ", ".join(f"{k}={v:.0f}%" for k, v in top)
            print(f"      \"{text[:42]:42s}\" -> {r.dominant:9s} ({top_s})"
                  f" sentiment={r.sentiment_dominant}")
            check(f"text '{expected}' detected", r.dominant == expected,
                  f"got {r.dominant}")

        # Empty input must not produce an emotion.
        r_empty = text_emotion.analyze_text("")
        check("empty text -> unavailable, no fabricated emotion", not r_empty.available)

        # Unsupported language must be flagged, not silently accepted.
        r_lang = text_emotion.analyze_text("Ich bin sehr glucklich heute", language="de")
        check("unsupported language flagged",
              r_lang.available and not r_lang.language_supported,
              f"language_supported={r_lang.language_supported}")

    # --- 7. Multimodal fusion ---------------------------------------------
    print("\n[7] Multimodal fusion")
    print("-" * 78)
    MI = multimodal_fusion.ModalityInput
    happy = {"happy": 80, "neutral": 10, "sad": 3, "angry": 2, "fear": 2, "surprise": 2, "disgust": 1}
    sad = {"happy": 4, "neutral": 16, "sad": 70, "angry": 4, "fear": 4, "surprise": 1, "disgust": 1}
    neutral = {"happy": 8, "neutral": 76, "sad": 6, "angry": 4, "fear": 3, "surprise": 2, "disgust": 1}

    # Agreement case
    agree = multimodal_fusion.fuse_modalities({
        "face": MI(happy, 90, 92), "voice": MI(happy, 80, 85), "text": MI(happy, 85, 90),
    })
    print(f"      all-happy      -> {agree.dominant:8s} conf={agree.confidence:5.1f}"
          f" agree={agree.agreement:5.1f}({agree.agreement_label}) rel={agree.reliability:5.1f}")
    check("agreeing modalities -> happy", agree.dominant == "happy")
    check("agreement is high", agree.agreement >= 70, f"{agree.agreement}")
    check("no disagreement flagged", not agree.disagreement)

    # The "I'm fine" case from the spec: text neutral, voice sad, face sad.
    mixed = multimodal_fusion.fuse_modalities({
        "face": MI(sad, 85, 90), "voice": MI(sad, 75, 80), "text": MI(neutral, 80, 85),
    })
    print(f"      face/voice sad, text neutral -> {mixed.dominant:8s}"
          f" agree={mixed.agreement:5.1f}({mixed.agreement_label}) rel={mixed.reliability:5.1f}")
    print(f"        per-modality: {mixed.per_modality_dominant}")
    check("disagreement detected", mixed.disagreement)
    check("agreement lower than the agreeing case", mixed.agreement < agree.agreement,
          f"{mixed.agreement} < {agree.agreement}")
    check("reliability reduced by disagreement", mixed.reliability < agree.reliability,
          f"{mixed.reliability} < {agree.reliability}")
    check("disagreement surfaced in notes", any("different emotions" in n for n in mixed.notes))

    # Full disagreement
    tri = multimodal_fusion.fuse_modalities({
        "face": MI(happy, 85, 90), "voice": MI(sad, 80, 85), "text": MI(neutral, 80, 85),
    })
    print(f"      three-way split -> {tri.dominant:8s} agree={tri.agreement:5.1f}({tri.agreement_label})")
    check("three-way split has low agreement", tri.agreement < 45, f"{tri.agreement}")

    # Single modality
    face_only = multimodal_fusion.fuse_modalities({
        "face": MI(happy, 90, 92), "voice": None, "text": None,
    })
    print(f"      face only      -> {face_only.dominant:8s} weights={face_only.effective_weights}")
    check("face-only uses 100% face", abs(face_only.effective_weights.get("face", 0) - 100) < 0.1,
          str(face_only.effective_weights))
    check("face-only noted", any("only the face" in n.lower() for n in face_only.notes))

    # Face + voice renormalization
    fv = multimodal_fusion.fuse_modalities({
        "face": MI(happy, 90, 90), "voice": MI(happy, 90, 90), "text": None,
    })
    total = sum(fv.effective_weights.values())
    print(f"      face+voice     -> weights={fv.effective_weights} (sum={total:.1f})")
    check("two-modality weights renormalize to 100", abs(total - 100) < 0.5, f"{total}")

    # No modality at all
    none_res = multimodal_fusion.fuse_modalities({"face": None, "voice": None, "text": None})
    check("no modalities -> uncertain, nothing invented", none_res.dominant == "uncertain")

    # Low-quality modality must not dominate a strong one.
    weak = multimodal_fusion.fuse_modalities({
        "face": MI(happy, 95, 95), "voice": MI(sad, 10, 15), "text": None,
    })
    print(f"      strong happy face + weak sad voice -> {weak.dominant}"
          f" weights={weak.effective_weights}")
    check("weak modality does not outvote strong one", weak.dominant == "happy")

    # --- 8. Full voice pipeline on unusable audio -------------------------
    print("\n[8] Voice pipeline gating (no fabrication on unusable audio)")
    print("-" * 78)
    r_sil = voice_service.analyze_audio_window(make_wav(silence()), want_transcript=False)
    print(f"      silence: analysis_used={r_sil.analysis_used} speech={r_sil.speech_detected}"
          f" msg={r_sil.message}")
    check("silence -> analysis_used False", r_sil.analysis_used is False)
    check("silence -> no voice emotion dict populated", not r_sil.voice)

    r_bad = voice_service.analyze_audio_window(b"garbage", want_transcript=False)
    check("undecodable audio -> success False with error", r_bad.success is False and bool(r_bad.error))

    r_empty = voice_service.analyze_audio_window(b"", want_transcript=False)
    check("empty upload -> error, not a result", r_empty.success is False)

    print("\n" + "=" * 78)
    failures = [r for r in results if r[0] == "FAIL"]
    print(f"RESULT: {len(results) - len(failures)}/{len(results)} checks passed")
    if failures:
        print("\nFAILURES:")
        for _, name, detail in failures:
            print(f"  FAIL  {name}  [{detail}]")
    print("=" * 78)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
