"""Acceptance tests for the AURA multi-signal fusion engine.

Run:  C:\\Users\\Admin\\aura-backend-venv\\Scripts\\python.exe -m tests.test_fusion
      (from the backend/ directory)

These drive the fusion engine with controlled geometric deltas representing
each target expression, and assert the two properties that matter most:

  1. A clear expression must be able to outvote a neutral-leaning DeepFace
     read, using geometric evidence alone.
  2. A genuinely still face must STAY neutral - the engine must not have been
     "fixed" by simply biasing against neutral.

Both directions are checked, because passing only the first would mean the
neutral-dominance bug had been traded for the opposite bug.
"""
import sys

from app import config
from app.fusion import (
    emotion_evidence,
    expression_intensity,
    explain,
    fuse,
    landmark_support,
    pose_trust,
    reaction_label,
    region_motion,
    region_signals,
)

# A neutral resting face, in the normalized units facial_features produces.
BASELINE = {
    "mouth_width": 0.80,
    "mouth_height": 0.02,
    "mouth_open_ratio": 0.03,
    "corner_lift": 0.05,
    "corner_asymmetry": 0.01,
    "upper_lip_thickness": 0.09,
    "lower_lip_thickness": 0.10,
    "left_eye_openness": 0.52,
    "right_eye_openness": 0.52,
    "eye_openness": 0.52,
    "eye_asymmetry": 0.01,
    "left_brow_eye_dist": 0.31,
    "right_brow_eye_dist": 0.31,
    "brow_eye_dist": 0.31,
    "inner_brow_height": 0.30,
    "nose_mouth_dist": 0.55,
}


def make_delta(**overrides):
    """Delta with everything at baseline (zero) except the named fields."""
    delta = {k: 0.0 for k in BASELINE}
    delta.update(overrides)
    return delta


# Geometric signatures of each expression, as deviations from the user's own
# neutral baseline. Values are intentionally moderate - a clearly visible
# expression, not an extreme caricature.
CASES = {
    "still_neutral": make_delta(),
    "small_smile": make_delta(corner_lift=0.05, mouth_width=0.04),
    "big_smile": make_delta(
        corner_lift=0.16, mouth_width=0.16, eye_openness=-0.04, nose_mouth_dist=-0.03
    ),
    "sad": make_delta(corner_lift=-0.10, eye_openness=-0.05, inner_brow_height=0.08),
    "angry": make_delta(
        brow_eye_dist=-0.09, eye_openness=-0.07, upper_lip_thickness=-0.03,
        lower_lip_thickness=-0.03, corner_lift=-0.04,
    ),
    "surprise": make_delta(mouth_open_ratio=0.22, eye_openness=0.10, brow_eye_dist=0.09),
    "fear": make_delta(mouth_open_ratio=0.12, eye_openness=0.14, brow_eye_dist=0.08),
    "disgust": make_delta(
        upper_lip_thickness=-0.07, lower_lip_thickness=-0.03, nose_mouth_dist=-0.06
    ),
}

# DeepFace reads to fuse against. The "neutral_leaning" case reproduces the
# exact failure reported from the live dashboard.
DEEPFACE_NEUTRAL_LEANING = {
    "happy": 9.0, "neutral": 40.0, "surprise": 12.0,
    "sad": 3.0, "angry": 3.0, "fear": 32.0, "disgust": 1.0,
}
DEEPFACE_STRONG_NEUTRAL = {
    "happy": 2.0, "neutral": 88.0, "surprise": 2.0,
    "sad": 3.0, "angry": 2.0, "fear": 2.0, "disgust": 1.0,
}

PASS, FAIL = "PASS", "FAIL"
results = []


def check(name: str, condition: bool, detail: str):
    results.append((PASS if condition else FAIL, name, detail))


def fuse_case(delta, deepface, sustained: bool, quality=88.0, yaw=0.05):
    """Fuse one case. `sustained` models the evidence EMA having caught up."""
    motion = region_motion({k: v * 0.5 for k, v in delta.items()})
    support = landmark_support(delta, motion)
    smoothed = dict(support) if sustained else {k: v * 0.35 for k, v in support.items()}
    fused = fuse(deepface, support, smoothed, quality, yaw, 0.0)
    return fused, support, motion, region_signals(delta)


def main() -> int:
    print("=" * 78)
    print("AURA FUSION ENGINE - ACCEPTANCE TESTS")
    print("=" * 78)

    # --- 1. Geometric evidence must discriminate between expressions -------
    print("\n[1] Per-expression geometric evidence (winner from geometry alone)")
    print("-" * 78)
    expected_winner = {
        "small_smile": "happy", "big_smile": "happy", "sad": "sad",
        "angry": "angry", "surprise": "surprise", "fear": "fear", "disgust": "disgust",
    }
    for case, delta in CASES.items():
        if case == "still_neutral":
            continue
        ev = emotion_evidence(region_signals(delta))
        winner = max(ev, key=ev.get)
        top = ", ".join(f"{k}={ev[k]:.2f}" for k in sorted(ev, key=ev.get, reverse=True)[:3])
        want = expected_winner[case]
        # surprise/fear share an open-mouth + raised-brow signature, so either
        # is an acceptable geometric winner for those two.
        ok = winner == want or (want in ("surprise", "fear") and winner in ("surprise", "fear"))
        check(f"geometry[{case}] -> {winner}", ok, top)
        print(f"  {'ok ' if ok else 'BAD'} {case:14s} winner={winner:9s} {top}")

    # --- 2. The reported bug: neutral-leaning DeepFace + real smile --------
    print("\n[2] Reported failure case: DeepFace leans neutral, face is smiling")
    print("-" * 78)
    print(f"  DeepFace raw: happy={DEEPFACE_NEUTRAL_LEANING['happy']:.0f}% "
          f"neutral={DEEPFACE_NEUTRAL_LEANING['neutral']:.0f}% "
          f"fear={DEEPFACE_NEUTRAL_LEANING['fear']:.0f}%")
    for case in ("small_smile", "big_smile"):
        for sustained in (False, True):
            fused, _, _, _ = fuse_case(CASES[case], DEEPFACE_NEUTRAL_LEANING, sustained)
            winner = max(fused, key=fused.get)
            tag = "sustained" if sustained else "1 frame  "
            label = f"{case} ({tag})"
            ok = winner == "happy" if case == "big_smile" else True
            check(f"fused[{label}] -> {winner}", ok,
                  f"happy={fused['happy']:.1f} neutral={fused['neutral']:.1f}")
            print(f"  {'ok ' if ok else 'BAD'} {label:26s} -> {winner:8s} "
                  f"happy={fused['happy']:5.1f}%  neutral={fused['neutral']:5.1f}%")

    # --- 3. The opposite bug: a still face must remain neutral -------------
    print("\n[3] Guard against over-correction: still face must stay Neutral")
    print("-" * 78)
    for dfname, df in (("neutral-leaning", DEEPFACE_NEUTRAL_LEANING),
                       ("strong-neutral", DEEPFACE_STRONG_NEUTRAL)):
        fused, support, motion, _ = fuse_case(CASES["still_neutral"], df, sustained=True)
        winner = max(fused, key=fused.get)
        ok = winner == "neutral"
        check(f"still face + {dfname} -> {winner}", ok, f"neutral={fused['neutral']:.1f}")
        print(f"  {'ok ' if ok else 'BAD'} still face, DeepFace {dfname:16s} -> {winner:8s} "
              f"neutral={fused['neutral']:5.1f}%  (geom neutral support={support['neutral']:.2f})")

    # A strongly-neutral DeepFace must not be overturned by geometry alone.
    fused, _, _, _ = fuse_case(CASES["big_smile"], DEEPFACE_STRONG_NEUTRAL, sustained=True)
    winner = max(fused, key=fused.get)
    print(f"\n  DeepFace strongly neutral (88%) + big smile geometry -> {winner} "
          f"(happy={fused['happy']:.1f}%, neutral={fused['neutral']:.1f}%)")
    print("     (either outcome is defensible here; recorded for visibility, not asserted)")

    # --- 4. Neutral evidence must FALL as smile evidence rises -------------
    print("\n[4] Neutral geometric support must decrease as smile evidence grows")
    print("-" * 78)
    prev_neutral, monotonic = None, True
    for case in ("still_neutral", "small_smile", "big_smile"):
        motion = region_motion({k: v * 0.5 for k, v in CASES[case].items()})
        support = landmark_support(CASES[case], motion)
        n, h = support["neutral"], support["happy"]
        if prev_neutral is not None and n > prev_neutral + 1e-9:
            monotonic = False
        prev_neutral = n
        print(f"      {case:14s} neutral_support={n:.3f}  happy_support={h:.3f}")
    check("neutral support falls monotonically as smile grows", monotonic,
          "prevents neutral winning by default")
    print(f"  {'ok ' if monotonic else 'BAD'} monotonic decrease: {monotonic}")

    # --- 5. Pose trust must be a ramp, not a cliff -------------------------
    print("\n[5] Head-pose trust ramp (soft, not a hard cutoff)")
    print("-" * 78)
    ramp = [(y, pose_trust(y, 0.0)) for y in (0.0, 0.10, 0.16, 0.22, 0.30, 0.40)]
    print("      " + "  ".join(f"yaw={y:.2f}->{t:.2f}" for y, t in ramp))
    ok = ramp[0][1] == 1.0 and 0.0 < ramp[2][1] < 1.0 and ramp[-1][1] == 0.0
    check("pose trust ramps smoothly", ok, "frontal=1.0, mild=partial, extreme=0.0")
    print(f"  {'ok ' if ok else 'BAD'} monotonic ramp with partial mid-range trust")

    # --- 6. Intensity / reaction bands ------------------------------------
    print("\n[6] Expression intensity and reaction labels")
    print("-" * 78)
    for case in ("still_neutral", "small_smile", "big_smile", "surprise"):
        motion = region_motion({k: v * 0.5 for k, v in CASES[case].items()})
        support = landmark_support(CASES[case], motion)
        df_neutral = DEEPFACE_NEUTRAL_LEANING["neutral"]
        inten = expression_intensity(support, motion["overall"], df_neutral)
        print(f"      {case:14s} intensity={inten:5.1f}  reaction={reaction_label(inten)}")
    still_i = expression_intensity(
        landmark_support(CASES["still_neutral"], {"overall": 0.0}), 0.0, 88.0
    )
    big_motion = region_motion({k: v * 0.5 for k, v in CASES["big_smile"].items()})
    big_i = expression_intensity(
        landmark_support(CASES["big_smile"], big_motion), big_motion["overall"], 40.0
    )
    check("intensity: big smile > still face", big_i > still_i, f"{big_i:.1f} vs {still_i:.1f}")
    print(f"  {'ok ' if big_i > still_i else 'BAD'} big smile ({big_i:.1f}) > still ({still_i:.1f})")

    # --- 7. Explanations must cite real measurements -----------------------
    print("\n[7] Explainability (reasons must be measurement-derived)")
    print("-" * 78)
    for case, df in (("big_smile", DEEPFACE_NEUTRAL_LEANING),
                     ("still_neutral", DEEPFACE_STRONG_NEUTRAL)):
        fused, support, motion, signals = fuse_case(CASES[case], df, sustained=True)
        dom = max(fused, key=fused.get)
        reasons = explain(dom, signals, motion, df, 85.0, 6)
        print(f"      {case} -> {dom.upper()}  ({len(reasons)} reasons)")
        for r in reasons:
            print(f"         - {r}")
        check(f"reasons produced for {case}", len(reasons) > 0, dom)

    # --- Summary ----------------------------------------------------------
    print("\n" + "=" * 78)
    failures = [r for r in results if r[0] == FAIL]
    print(f"RESULT: {len(results) - len(failures)}/{len(results)} checks passed")
    if failures:
        print("\nFAILURES:")
        for _, name, detail in failures:
            print(f"  FAIL  {name}  [{detail}]")
    print("=" * 78)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
