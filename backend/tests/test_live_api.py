"""Live end-to-end check against a running AURA backend.

Run (from backend/, with the server up on :8000):
    C:\\Users\\Admin\\aura-backend-venv\\Scripts\\python.exe -m tests.test_live_api

Exercises the real HTTP path - decode, quality gate, alignment, Face Mesh,
DeepFace, fusion, reliability - and prints the raw-vs-fused comparison so the
final distribution can be checked against DeepFace's own read.
"""
import json
import os
import sys
import tempfile
import uuid

import requests

from tests.config import ORIGIN

BASE = ORIGIN
FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


def find_images():
    """Prefer labeled fixtures; fall back to the scratch closeup."""
    images = []
    if os.path.isdir(FIXTURES):
        for name in sorted(os.listdir(FIXTURES)):
            if name.lower().endswith((".jpg", ".jpeg", ".png")):
                images.append(os.path.join(FIXTURES, name))
    if not images:
        fallback = os.path.join(tempfile.gettempdir(), "face_closeup.jpg")
        if os.path.exists(fallback):
            images.append(fallback)
    return images


def post_frame(session_id, path):
    with open(path, "rb") as f:
        data = f.read()
    r = requests.post(
        f"{BASE}/api/analyze-emotion",
        files={"frame": ("frame.jpg", data, "image/jpeg")},
        data={"session_id": session_id},
        timeout=60,
    )
    r.raise_for_status()
    return r.json()


def main() -> int:
    try:
        health = requests.get(f"{BASE}/health", timeout=5).json()
        version = requests.get(f"{BASE}/api/version", timeout=5).json()
    except Exception as exc:  # noqa: BLE001
        print(f"Backend not reachable at {BASE}: {exc}")
        return 1

    print("=" * 78)
    print(f"LIVE API TEST  -  {health.get('service')}  v{version.get('version')}")
    print("=" * 78)

    images = find_images()
    if not images:
        print("No test images found.")
        return 1
    print(f"{len(images)} test image(s)\n")

    failures = 0

    for path in images:
        name = os.path.basename(path)
        session_id = str(uuid.uuid4())  # fresh session => fresh baseline
        print("-" * 78)
        print(f"IMAGE: {name}")
        print("-" * 78)

        last = None
        # Repeat the frame so calibration completes and the temporal EMA warms.
        for i in range(5):
            try:
                last = post_frame(session_id, path)
            except Exception as exc:  # noqa: BLE001
                print(f"  request {i} failed: {exc}")
                failures += 1
                break

            if not last.get("success"):
                print(f"  frame {i}: success=False error={last.get('error')}")
                continue
            if not last.get("analysis_used"):
                print(f"  frame {i}: SKIPPED (analysis_used=False) - {last.get('message')}")
                continue

            e, dbg = last["emotion"], last["debug"]
            print(
                f"  frame {i}: fused={e['dominant']:9s} conf={e['confidence']:5.1f}%"
                f" rel={e['reliability']:5.1f}%   deepface={dbg['deepface_dominant']:9s}"
                f" trust={dbg['landmark_trust']:.2f} calibrating={dbg['calibrating']}"
            )

        if last and last.get("analysis_used"):
            e, dbg = last["emotion"], last["debug"]
            print()
            print(f"  FINAL fused distribution : {json.dumps(e['scores'])}")
            print(f"  raw DeepFace distribution: {json.dumps(dbg['deepface_scores'])}")
            differs = e["dominant"] != dbg["deepface_dominant"]
            print(f"  fused dominant differs from DeepFace: {differs}")
            print(f"  intensity={e['expression_intensity']} reaction={e['overall_reaction']}")
            print(f"  quality={last['quality']['overall']}% ({last['quality']['label']})"
                  f" head_pose_ok={last['quality']['head_pose_ok']}")
            print(f"  yaw={dbg['yaw_ratio']} pitch={dbg['pitch_ratio']} roll={dbg['roll_degrees']}deg")
            evidence = {k: v for k, v in dbg["signals"].items() if v > 1.0}
            print(f"  active geometric signals : {json.dumps(evidence)}")
            print(f"  region motion            : {json.dumps(dbg['region_motion'])}")
            if last.get("reaction", {}).get("events"):
                print(f"  events                   : {last['reaction']['events']}")
            print("  reasons:")
            for r in e["reasons"]:
                print(f"    - {r}")
        print()

    # --- No-face frame must NOT become neutral -----------------------------
    print("-" * 78)
    print("GUARD: a frame with no face must not be reported as an emotion")
    print("-" * 78)
    import numpy as np
    import cv2

    noise = np.random.randint(0, 255, (480, 640, 3), dtype=np.uint8)
    blank_path = os.path.join(tempfile.gettempdir(), "aura_noface.jpg")
    cv2.imwrite(blank_path, noise)
    result = post_frame(str(uuid.uuid4()), blank_path)
    used = result.get("analysis_used")
    emotion = (result.get("emotion") or {}).get("dominant")
    ok = used is False and emotion is None
    print(f"  analysis_used={used}  emotion={emotion}  message={result.get('message')}")
    print(f"  {'ok ' if ok else 'BAD'} no-face frame did not produce an emotion")
    if not ok:
        failures += 1

    print("\n" + "=" * 78)
    print("FAILURES:" if failures else "All live checks passed.")
    if failures:
        print(f"  {failures} failure(s)")
    print("=" * 78)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
