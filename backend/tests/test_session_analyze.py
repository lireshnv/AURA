"""Live tests for the one-click /api/session/analyze endpoint.

Run (from backend/, server up on :8000):
    C:\\Users\\Admin\\aura-backend-venv\\Scripts\\python.exe -m tests.test_session_analyze

Asserts the properties that matter for a decision-support signal:
  * every number traces back to the CV/audio/NLP models, not the explainer
  * a low-quality modality cannot dominate a high-quality one
  * disagreement is surfaced and lowers reliability
  * human review is recommended when the evidence warrants it
  * no diagnostic or absolute language is ever emitted
"""
import sys

import requests

from tests.config import ORIGIN

B = ORIGIN
results = []

HAPPY = {"happy": 82, "neutral": 9, "sad": 3, "angry": 2, "fear": 2, "surprise": 1, "disgust": 1}
SAD = {"happy": 4, "neutral": 14, "sad": 72, "angry": 4, "fear": 4, "surprise": 1, "disgust": 1}
NEUTRAL = {"happy": 8, "neutral": 76, "sad": 6, "angry": 4, "fear": 3, "surprise": 2, "disgust": 1}

# Language that must never appear in ASSERTIVE text (headline, reasons,
# inconsistencies, review reason).
#
# Note the deliberate omission of a bare "diagnos" stem: the safety disclaimer
# legitimately says "not a clinical or diagnostic assessment", so matching the
# stem would flag the disclaimer itself. The forbidden entries below are
# diagnostic *claims*, and the disclaimer is asserted separately as REQUIRED.
FORBIDDEN = [
    "definitely", "is crying", "she is crying", "traumatised", "traumatized",
    "has depression", "is depressed", "mentally ill", "proves", "certainly",
    "diagnosis of", "is diagnosed", "suffers from", "confirms that",
]


def check(name, ok, detail=""):
    results.append(("PASS" if ok else "FAIL", name, detail))
    print(f"  {'ok ' if ok else 'BAD'} {name}" + (f"  [{detail}]" if detail else ""))


def analyse(body):
    r = requests.post(f"{B}/api/session/analyze", json=body, timeout=60)
    r.raise_for_status()
    return r.json()


def assertive_text(res):
    """Only the text that makes claims about the person.

    Limitations are excluded on purpose: that is where the "not a clinical or
    diagnostic assessment" disclaimer lives, and it is asserted as REQUIRED in
    a separate check rather than scanned for forbidden words.
    """
    e = res["explanation"]
    return " ".join(
        [e["headline"], *e["reasons"], *e["inconsistencies"],
         e.get("human_review_reason") or ""]
    ).lower()


def main() -> int:
    print("=" * 78)
    print("ONE-CLICK /api/session/analyze")
    print("=" * 78)

    # --- 1. All three modalities agreeing --------------------------------
    print("\n[1] All modalities agree (happy)")
    print("-" * 78)
    res = analyse({
        "face": {"scores": HAPPY, "confidence": 88, "quality": 92},
        "voice": {"scores": HAPPY, "confidence": 76, "quality": 84},
        "text": {"scores": HAPPY, "confidence": 84, "quality": 88},
        "face_detail": {
            "dominant": "happy", "confidence": 88, "quality": 92,
            "signals": {"smile": 81, "mouth_open": 12, "brow_raise": 8},
            "motion": {"overall": 46},
            "blink": {"blink_count": 3, "observed_seconds": 22},
        },
        "voice_detail": {"available": True, "dominant": "happy", "confidence": 76,
                         "stress": {"speech_rate": "Moderate", "pause_ratio": 0.18}},
        "text_detail": {"available": True, "dominant": "happy", "confidence": 84,
                        "sentiment": {"dominant": "positive"}},
        "trend": {"direction": "increasing", "emotion": "happy", "delta": 14.0},
    })
    c = res["combined"]
    print(f"      combined={c['dominant']} signal={c['signal']:.0f}% conf={c['confidence']:.0f}%"
          f" rel={c['reliability']:.0f}% agree={res['agreement']['score']:.0f}%")
    print(f"      headline: {res['explanation']['headline']}")
    for r_ in res["explanation"]["reasons"][:5]:
        print(f"        - {r_}")
    check("combined is happy", c["dominant"] == "happy")
    check("all three modalities used", set(res["modalities_used"]) == {"face", "voice", "text"})
    check("weights sum to 100", abs(sum(res["effective_weights"].values()) - 100) < 0.5)
    check("reasons are non-empty", len(res["explanation"]["reasons"]) > 0)
    check("no inconsistency when all agree", len(res["explanation"]["inconsistencies"]) == 0)
    check("no human review needed", res["explanation"]["human_review_recommended"] is False)
    check("explanation is deterministic (not an LLM)",
          res["explanation"]["generated_by"] == "deterministic-rules")
    agree_rel = c["reliability"]

    # --- 2. The disagreement case ----------------------------------------
    print("\n[2] Face/voice sad, text neutral ('I'm fine')")
    print("-" * 78)
    res2 = analyse({
        "face": {"scores": SAD, "confidence": 80, "quality": 88},
        "voice": {"scores": SAD, "confidence": 70, "quality": 78},
        "text": {"scores": NEUTRAL, "confidence": 78, "quality": 60},
        "face_detail": {"dominant": "sad", "confidence": 80, "quality": 88,
                        "signals": {"corner_droop": 62, "eye_narrowing": 44},
                        "motion": {"overall": 18}},
        "voice_detail": {"available": True, "dominant": "sad", "confidence": 70,
                         "stress": {"speech_rate": "Slow", "pause_ratio": 0.42}},
        "text_detail": {"available": True, "dominant": "neutral", "confidence": 78,
                        "sentiment": {"dominant": "neutral"}},
        "trend": {"direction": "increasing", "emotion": "sad", "delta": 11.0},
    })
    c2 = res2["combined"]
    print(f"      combined={c2['dominant']} rel={c2['reliability']:.0f}%"
          f" agree={res2['agreement']['score']:.0f}% ({res2['agreement']['label']})")
    for i in res2["explanation"]["inconsistencies"]:
        print(f"        ! {i}")
    print(f"      review: {res2['explanation']['human_review_reason']}")
    check("disagreement detected", res2["agreement"]["disagreement"] is True)
    check("inconsistency reported", len(res2["explanation"]["inconsistencies"]) > 0)
    check("reliability lower than agreeing case", c2["reliability"] < agree_rel,
          f"{c2['reliability']} < {agree_rel}")
    check("human review recommended", res2["explanation"]["human_review_recommended"] is True)
    check("sustained negative trend cited in review",
          "negative" in (res2["explanation"]["human_review_reason"] or "").lower())

    # --- 3. Low-quality modality must not dominate ------------------------
    print("\n[3] Strong clear face vs weak noisy voice")
    print("-" * 78)
    res3 = analyse({
        "face": {"scores": HAPPY, "confidence": 92, "quality": 94},
        "voice": {"scores": SAD, "confidence": 12, "quality": 15},
    })
    print(f"      combined={res3['combined']['dominant']} weights={res3['effective_weights']}")
    check("high-quality face wins over low-quality voice",
          res3["combined"]["dominant"] == "happy")
    check("weak modality got the smaller weight",
          res3["effective_weights"]["face"] > res3["effective_weights"]["voice"],
          str(res3["effective_weights"]))

    # --- 4. Single modality ----------------------------------------------
    print("\n[4] Face only (mic denied or unavailable)")
    print("-" * 78)
    res4 = analyse({
        "face": {"scores": HAPPY, "confidence": 88, "quality": 90},
        "voice_detail": {"available": False},
        "text_detail": {"available": False},
    })
    print(f"      combined={res4['combined']['dominant']} used={res4['modalities_used']}")
    print(f"      limitations: {res4['explanation']['limitations'][0]}")
    check("face-only still produces a result", res4["combined"]["dominant"] == "happy")
    check("single-modality limitation stated",
          any("modality" in l.lower() for l in res4["explanation"]["limitations"]))
    check("unavailable voice mentioned in reasons",
          any("voice" in r_.lower() for r_ in res4["explanation"]["reasons"]))

    # --- 5. Nothing available --------------------------------------------
    print("\n[5] No modality available")
    print("-" * 78)
    res5 = analyse({})
    print(f"      combined={res5['combined']['dominant']}")
    print(f"      headline: {res5['explanation']['headline']}")
    check("no modality -> uncertain, nothing invented",
          res5["combined"]["dominant"] == "uncertain")

    # --- 6. Safety: no diagnostic or absolute language --------------------
    print("\n[6] Safety wording across all responses")
    print("-" * 78)
    for idx, res_ in enumerate([res, res2, res3, res4, res5], start=1):
        text = assertive_text(res_)
        hits = [w for w in FORBIDDEN if w in text]
        check(f"response {idx} makes no diagnostic/absolute claim", not hits, str(hits))

    # The disclaimer must be PRESENT - the inverse of the check above.
    for idx, res_ in enumerate([res, res2, res3, res4, res5], start=1):
        joined = " ".join(res_["explanation"]["limitations"]).lower()
        check(f"response {idx} carries the not-a-diagnosis disclaimer",
              "diagnostic" in joined or "not measurements of inner" in joined)

    for idx, res_ in enumerate([res, res2, res3, res4], start=1):
        check(f"response {idx} states the not-a-diagnosis limitation",
              any("not a clinical" in l.lower() or "not measurements of inner" in l.lower()
                  for l in res_["explanation"]["limitations"]))

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
