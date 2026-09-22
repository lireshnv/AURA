"""Live tests for the portal add-ons: distress signal, themes, history.

Run (from backend/, server up on :8000):
    C:\\Users\\Admin\\aura-backend-venv\\Scripts\\python.exe -m tests.test_portal
"""
import sys
import time

import requests

from tests.config import ORIGIN

B = ORIGIN
results = []

NEG = {"happy": 3, "neutral": 15, "sad": 62, "angry": 8, "fear": 9, "surprise": 2, "disgust": 1}
POS = {"happy": 78, "neutral": 12, "sad": 3, "angry": 2, "fear": 3, "surprise": 1, "disgust": 1}


def check(name, ok, detail=""):
    results.append(("PASS" if ok else "FAIL", name, detail))
    print(f"  {'ok ' if ok else 'BAD'} {name}" + (f"  [{detail}]" if detail else ""))


def signal(body):
    r = requests.post(f"{B}/api/distress/signal", json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def main() -> int:
    print("=" * 78)
    print("AURA PORTAL - DISTRESS SIGNAL / THEMES / HISTORY")
    print("=" * 78)

    # --- 1. Insufficient data must not produce a score --------------------
    print("\n[1] Insufficient observations")
    print("-" * 78)
    r = signal({"emotion_window": [POS, POS], "sentiment_window": []})
    print(f"      insufficient={r['insufficient_data']} score={r['score']} level={r['level']}")
    check("too few observations -> insufficient_data", r["insufficient_data"] is True)
    check("no score invented", r["score"] == 0.0)
    check("disclaimer always present", "not a clinical diagnosis" in r["disclaimer"].lower())

    # --- 2. Sustained positive -> low signal ------------------------------
    print("\n[2] Sustained positive expression")
    print("-" * 78)
    r_pos = signal({
        "emotion_window": [POS] * 12,
        "sentiment_window": [{"positive": 75, "neutral": 20, "negative": 5}] * 12,
        "face_motion": 45, "reliability": 90,
    })
    print(f"      score={r_pos['score']} level={r_pos['level']} conf={r_pos['confidence']}")
    for f in r_pos["factors"]:
        print(f"        - {f['label']}: {f['detail']}")
    check("positive session -> GREEN", r_pos["level"] == "GREEN", str(r_pos["score"]))

    # --- 3. Sustained negative -> elevated signal -------------------------
    print("\n[3] Sustained negative expression + negative sentiment")
    print("-" * 78)
    r_neg = signal({
        "emotion_window": [NEG] * 12,
        "sentiment_window": [{"positive": 5, "neutral": 20, "negative": 75}] * 12,
        "voice_stress": 0.7, "face_motion": 10, "reliability": 88,
        "transcript": "I have been feeling really sad and alone lately, and I am worried about tomorrow.",
    })
    print(f"      score={r_neg['score']} level={r_neg['level']} conf={r_neg['confidence']}")
    for f in r_neg["factors"]:
        print(f"        - {f['label']} ({f['direction']}): {f['detail']}")
    print(f"      components: {r_neg['components']}")
    check("negative session scores higher than positive",
          r_neg["score"] > r_pos["score"], f"{r_neg['score']} > {r_pos['score']}")
    check("negative session is AMBER or RED", r_neg["level"] in ("AMBER", "RED"), r_neg["level"])
    check("factors name what drove it", len(r_neg["factors"]) >= 2)
    check("factor weights exposed for auditability", bool(r_neg["factor_weights"]))

    # --- 4. Themes must be evidence-backed --------------------------------
    print("\n[4] Emotional themes (must cite matched words)")
    print("-" * 78)
    themes = r_neg["themes"]
    for t in themes:
        print(f"        - {t['theme']}: {t['matches']}")
    check("themes detected from transcript", len(themes) > 0)
    check("every theme cites matched words",
          all(len(t["matches"]) > 0 for t in themes))
    names = {t["theme"] for t in themes}
    check("low mood theme found", "low mood" in names, str(names))
    check("isolation theme found", "isolation" in names, str(names))
    check("worry theme found", "worry / uncertainty" in names, str(names))

    r_empty = signal({"emotion_window": [POS] * 8, "sentiment_window": [], "transcript": ""})
    check("no transcript -> no invented themes", r_empty["themes"] == [])

    # --- 5. Low reliability must damp the score ---------------------------
    print("\n[5] Reliability damping")
    print("-" * 78)
    r_low = signal({
        "emotion_window": [NEG] * 12,
        "sentiment_window": [{"positive": 5, "neutral": 20, "negative": 75}] * 12,
        "voice_stress": 0.7, "face_motion": 10, "reliability": 20,
        "transcript": "I feel sad and alone.",
    })
    print(f"      reliability 88 -> {r_neg['score']} | reliability 20 -> {r_low['score']}")
    check("low reliability lowers the score", r_low["score"] < r_neg["score"],
          f"{r_low['score']} < {r_neg['score']}")

    # --- 6. History round-trip -------------------------------------------
    print("\n[6] History persistence")
    print("-" * 78)
    before = requests.get(f"{B}/api/history/sessions", timeout=15).json()
    start_count = before["count"]

    saved = requests.post(f"{B}/api/history/session", json={
        "duration_seconds": 92.5,
        "observed_emotion": "sad",
        "emotion_confidence": 68.0,
        "distress_score": r_neg["score"],
        "distress_level": r_neg["level"],
        "sentiment_dominant": "negative",
        "agreement": 71.0,
        "modalities": ["face", "voice", "text"],
        "valid_observations": 24,
        "emotion_scores": NEG,
        "sentiment_scores": {"positive": 5, "neutral": 20, "negative": 75},
        "factors": r_neg["factors"],
        "transcript_excerpt": "I have been feeling really sad and alone lately.",
        "notes": ["Test session"],
    }, timeout=15).json()
    print(f"      saved id={saved.get('id')}")
    check("session saved", saved.get("success") is True and bool(saved.get("id")))

    after = requests.get(f"{B}/api/history/sessions", timeout=15).json()
    print(f"      count {start_count} -> {after['count']}")
    check("history count increased", after["count"] == start_count + 1)

    row = next((s for s in after["sessions"] if s["id"] == saved.get("id")), None)
    check("saved row retrievable", row is not None)
    if row:
        print(f"      row: {row['observed_emotion']} distress={row['distress_score']}"
              f" level={row['distress_level']} modalities={row['modalities']}")
        check("emotion scores round-tripped", row["emotion_scores"].get("sad") == 62)
        check("modalities round-tripped", row["modalities"] == ["face", "voice", "text"])
        check("factors round-tripped", len(row["factors"]) > 0)
        check("no raw media field stored",
              not any(k in row for k in ("video", "audio", "image", "frame")))

    # --- 7. Trend ---------------------------------------------------------
    print("\n[7] Trend")
    print("-" * 78)
    trend = after["trend"]
    print(f"      {trend}")
    check("trend reported", "direction" in trend)
    check("trend honest when too few sessions",
          trend["direction"] != "insufficient" or trend["sessions_compared"] < 2)

    # Add a second, calmer session and confirm the trend can move.
    requests.post(f"{B}/api/history/session", json={
        "duration_seconds": 60, "observed_emotion": "neutral",
        "distress_score": 12.0, "distress_level": "GREEN",
        "sentiment_dominant": "neutral", "modalities": ["face"],
        "valid_observations": 18, "emotion_scores": POS,
    }, timeout=15)
    time.sleep(0.2)
    after2 = requests.get(f"{B}/api/history/sessions", timeout=15).json()
    print(f"      after 2nd session: {after2['trend']}")
    check("trend computable with 2+ sessions",
          after2["trend"]["direction"] in ("increasing", "decreasing", "stable"),
          after2["trend"]["direction"])

    # --- 8. Cleanup -------------------------------------------------------
    print("\n[8] Clear history")
    print("-" * 78)
    cleared = requests.delete(f"{B}/api/history/sessions", timeout=15).json()
    final = requests.get(f"{B}/api/history/sessions", timeout=15).json()
    print(f"      deleted={cleared.get('deleted')} remaining={final['count']}")
    check("history cleared", final["count"] == 0)

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
