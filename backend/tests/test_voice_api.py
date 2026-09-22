"""Live HTTP tests for the voice/text/multimodal endpoints.

Run (from backend/, server up on :8000):
    C:\\Users\\Admin\\aura-backend-venv\\Scripts\\python.exe -m tests.test_voice_api

The FIRST assertion is the most important one in this file: the pre-existing
facial endpoint must still behave exactly as before. Adding voice must not
regress the DeepFace video path.
"""
import io
import os
import sys
import tempfile
import uuid
import wave

import numpy as np
import requests

from tests.config import ORIGIN

B = ORIGIN
results = []

HAPPY = {"happy": 80, "neutral": 10, "sad": 3, "angry": 2, "fear": 2, "surprise": 2, "disgust": 1}
SAD = {"happy": 4, "neutral": 16, "sad": 70, "angry": 4, "fear": 4, "surprise": 1, "disgust": 1}
NEUTRAL = {"happy": 8, "neutral": 76, "sad": 6, "angry": 4, "fear": 3, "surprise": 2, "disgust": 1}


def check(name, ok, detail=""):
    results.append(("PASS" if ok else "FAIL", name, detail))
    print(f"  {'ok ' if ok else 'BAD'} {name}" + (f"  [{detail}]" if detail else ""))


def make_wav(samples, sr=16000):
    pcm = np.clip(samples * 32767, -32768, 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def main() -> int:
    print("=" * 78)
    print("AURA VOICE / TEXT / MULTIMODAL - LIVE HTTP TESTS")
    print("=" * 78)

    # --- 1. Regression guard: the facial endpoint is untouched -------------
    print("\n[1] EXISTING facial endpoint must be unaffected")
    print("-" * 78)
    face_img_path = os.path.join(tempfile.gettempdir(), "face_closeup.jpg")
    if os.path.exists(face_img_path):
        img = open(face_img_path, "rb").read()
        r = requests.post(
            f"{B}/api/analyze-emotion",
            files={"frame": ("f.jpg", img, "image/jpeg")},
            data={"session_id": str(uuid.uuid4())},
            timeout=90,
        )
        d = r.json()
        check("facial endpoint returns 200", r.status_code == 200)
        check("facial analysis_used True", d.get("analysis_used") is True)
        check("fused emotion present", bool(d.get("emotion", {}).get("dominant")))
        check("raw DeepFace still exposed in debug", bool(d.get("debug", {}).get("deepface_dominant")))
        check("facial response has no voice keys", "transcript" not in d and "voice" not in d)
        print(f"      fused={d['emotion']['dominant']} {d['emotion']['confidence']:.1f}%"
              f"  deepface={d['debug']['deepface_dominant']}")
    else:
        print("      (no face fixture available; skipped)")

    # --- 2. Capabilities --------------------------------------------------
    print("\n[2] GET /api/voice/capabilities")
    print("-" * 78)
    caps = requests.get(f"{B}/api/voice/capabilities", timeout=15).json()
    for k, v in caps.items():
        print(f"      {k:20s} {v}")
    check("capabilities reported", isinstance(caps, dict) and "speech_to_text" in caps)

    # --- 3. Text emotion --------------------------------------------------
    print("\n[3] POST /api/text/emotion")
    print("-" * 78)
    cases = [
        ("I am really happy to see you today!", "happy", "positive"),
        ("I am worried about what will happen tomorrow.", "fear", "negative"),
        ("I feel completely hopeless and alone.", "sad", "negative"),
    ]
    for text, want_emotion, want_sentiment in cases:
        r = requests.post(f"{B}/api/text/emotion", json={"text": text, "language": "en"}, timeout=60)
        d = r.json()
        if not d.get("success"):
            check(f"text: {text[:32]}", False, d.get("error", "failed"))
            continue
        got_e = d["emotion"]["dominant"]
        got_s = d["sentiment"]["dominant"]
        print(f"      \"{text[:44]:44s}\" -> {got_e:8s} {d['emotion']['confidence']:5.1f}%"
              f"  sentiment={got_s}")
        for e in d.get("evidence", [])[:2]:
            print(f"         - {e}")
        check(f"text emotion '{want_emotion}'", got_e == want_emotion, f"got {got_e}")
        check(f"text sentiment '{want_sentiment}'", got_s == want_sentiment, f"got {got_s}")

    r = requests.post(f"{B}/api/text/emotion", json={"text": ""}, timeout=30).json()
    check("empty text -> success False, no fabricated emotion", r.get("success") is False)

    # --- 4. Multimodal fusion --------------------------------------------
    print("\n[4] POST /api/multimodal/analyze")
    print("-" * 78)

    r = requests.post(f"{B}/api/multimodal/analyze", json={
        "face": {"scores": HAPPY, "confidence": 90, "quality": 92},
        "voice": {"scores": HAPPY, "confidence": 80, "quality": 85},
        "text": {"scores": HAPPY, "confidence": 85, "quality": 90},
    }, timeout=30).json()
    print(f"      all agree -> {r['emotion']['dominant']:8s} conf={r['emotion']['confidence']:5.1f}"
          f" rel={r['emotion']['reliability']:5.1f} agree={r['agreement']['score']:5.1f}"
          f"({r['agreement']['label']}) weights={r['effective_weights']}")
    agree_score = r["agreement"]["score"]
    agree_rel = r["emotion"]["reliability"]
    check("all-agree -> happy", r["emotion"]["dominant"] == "happy")
    check("all-agree agreement high", r["agreement"]["label"] == "high", str(agree_score))
    check("no disagreement flagged", r["agreement"]["disagreement"] is False)

    # The spec's "I'm fine" scenario.
    r = requests.post(f"{B}/api/multimodal/analyze", json={
        "face": {"scores": SAD, "confidence": 85, "quality": 90},
        "voice": {"scores": SAD, "confidence": 75, "quality": 80},
        "text": {"scores": NEUTRAL, "confidence": 80, "quality": 85},
    }, timeout=30).json()
    print(f"      'I'm fine' -> {r['emotion']['dominant']:8s} agree={r['agreement']['score']:5.1f}"
          f"({r['agreement']['label']}) rel={r['emotion']['reliability']:5.1f}")
    print(f"        per-modality: {r['agreement']['per_modality_dominant']}")
    for n in r["notes"]:
        print(f"        - {n}")
    check("disagreement detected", r["agreement"]["disagreement"] is True)
    check("agreement lower than all-agree", r["agreement"]["score"] < agree_score,
          f"{r['agreement']['score']} < {agree_score}")
    check("reliability reduced vs all-agree", r["emotion"]["reliability"] < agree_rel,
          f"{r['emotion']['reliability']} < {agree_rel}")
    check("disagreement explained in notes", any("different emotions" in n for n in r["notes"]))

    # Single modality
    r = requests.post(f"{B}/api/multimodal/analyze", json={
        "face": {"scores": HAPPY, "confidence": 90, "quality": 92},
    }, timeout=30).json()
    print(f"      face only -> {r['emotion']['dominant']:8s} weights={r['effective_weights']}"
          f" used={r['modalities_used']}")
    check("face-only weight is 100%", abs(r["effective_weights"].get("face", 0) - 100) < 0.1)
    check("face-only lists only face", r["modalities_used"] == ["face"])

    # Voice only
    r = requests.post(f"{B}/api/multimodal/analyze", json={
        "voice": {"scores": SAD, "confidence": 78, "quality": 82},
    }, timeout=30).json()
    print(f"      voice only -> {r['emotion']['dominant']:8s} weights={r['effective_weights']}")
    check("voice-only works", r["emotion"]["dominant"] == "sad" and r["modalities_used"] == ["voice"])

    # Nothing supplied
    r = requests.post(f"{B}/api/multimodal/analyze", json={}, timeout=30).json()
    check("no modalities -> uncertain, nothing invented",
          r["emotion"]["dominant"] == "uncertain", str(r.get("notes")))

    # --- 5. Voice endpoints with real audio ------------------------------
    print("\n[5] POST /api/voice/emotion  (silence must not fabricate)")
    print("-" * 78)
    silence = np.zeros(16000 * 3, dtype=np.float32)
    r = requests.post(f"{B}/api/voice/emotion",
                      files={"audio": ("w.wav", make_wav(silence), "audio/wav")},
                      data={"include_transcript": "false"}, timeout=120).json()
    print(f"      silence -> analysis_used={r.get('analysis_used')} speech={r.get('speech_detected')}"
          f" msg={r.get('message')}")
    check("silence -> analysis_used False", r.get("analysis_used") is False)
    check("silence -> no voice emotion returned", not r.get("voice"))

    r = requests.post(f"{B}/api/voice/emotion",
                      files={"audio": ("w.wav", b"not audio", "audio/wav")},
                      data={"include_transcript": "false"}, timeout=60).json()
    check("garbage audio -> success False with error",
          r.get("success") is False and bool(r.get("error")))

    # A tone is not speech, but it does exercise the full model path.
    t = np.linspace(0, 3, 16000 * 3, endpoint=False)
    tone = (0.25 * (np.sin(2 * np.pi * 180 * t) + 0.5 * np.sin(2 * np.pi * 360 * t))).astype(np.float32)
    r = requests.post(f"{B}/api/voice/emotion",
                      files={"audio": ("w.wav", make_wav(tone), "audio/wav")},
                      data={"include_transcript": "true"}, timeout=300).json()
    print(f"      tone -> success={r.get('success')} analysis_used={r.get('analysis_used')}"
          f" vad={r.get('vad_method')}")
    check("tone request completes without server error", r.get("success") is True)
    if r.get("analysis_used"):
        v = r.get("voice", {})
        ac = r.get("acoustic", {})
        print(f"        voice model available={v.get('available')} dominant={v.get('dominant')}"
              f" conf={v.get('confidence')}")
        print(f"        pitch={ac.get('pitch', {}).get('mean_hz')} Hz"
              f"  energy_norm={ac.get('energy', {}).get('normalized')}")
        print(f"        stress={r.get('stress', {}).get('contribution_label')}")
        check("acoustic features returned", ac.get("available") is True)
        check("voice emotion model ran", v.get("available") is True)

    print("\n" + "=" * 78)
    failures = [x for x in results if x[0] == "FAIL"]
    print(f"RESULT: {len(results) - len(failures)}/{len(results)} checks passed")
    if failures:
        print("\nFAILURES:")
        for _, name, detail in failures:
            print(f"  FAIL  {name}  [{detail}]")
    print("=" * 78)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
