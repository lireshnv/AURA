"""Tests for the Personal Well-being Digital Twin.

Run (from backend/, server up on :8000):
    C:\\Users\\Admin\\aura-backend-venv\\Scripts\\python.exe -m tests.test_twin

The central assertions are the NO-FABRICATION guarantees from spec section 11:
with no data the twin must say so; consent must gate every write; a missing
modality must read "Insufficient signal"; and no synthetic record may ever
appear in the user's own twin.

This test deletes all twin data at start and finish, so it must only be run
against a development instance.
"""
import sys

import requests

from tests.config import ORIGIN

B = ORIGIN + "/api/twin"
results = []

SYNTHETIC_MARKERS = ["AURA-1042", "AURA-2178", "AURA-3315", "Victim A", "Victim B", "Victim C"]


def check(name, ok, detail=""):
    results.append(("PASS" if ok else "FAIL", name, detail))
    print(f"  {'ok ' if ok else 'BAD'} {name}" + (f"  [{detail}]" if detail else ""))


def wipe():
    requests.delete(f"{B}/privacy/all", timeout=15)


def set_consent(scope, granted):
    return requests.post(
        f"{B}/consent", json={"scope": scope, "granted": granted}, timeout=15
    ).json()


def view():
    return requests.get(f"{B}/view", timeout=20).json()


def main() -> int:
    print("=" * 78)
    print("PERSONAL WELL-BEING DIGITAL TWIN")
    print("=" * 78)

    wipe()

    # --- 1. Empty state: nothing fabricated -------------------------------
    print("\n[1] Empty state (no data at all)")
    print("-" * 78)
    v = view()
    print(f"      baseline: {v['baseline']['status_label']}")
    print(f"      pattern : {v['pattern_label']}")
    print(f"      modality: {v['modality_status']}")
    check("has_data is False", v["has_data"] is False)
    check("baseline reports 'Baseline building...'",
          v["baseline"]["status_label"] == "Baseline building...")
    check("baseline confidence is 0, not invented", v["baseline"]["confidence"] == 0.0)
    check("confidence dots are 0", v["baseline"]["confidence_dots"] == 0)
    check("change unavailable with reason", v["change"]["available"] is False)
    check("trend unavailable with reason", v["trend"]["available"] is False)
    check("every modality reports Insufficient signal",
          all(s == "Insufficient signal" for s in v["modality_status"].values()))
    check("no recent changes invented", v["recent_changes"] == [])
    check("no baseline values invented", v["baseline"]["values"] == {})
    check("safety note present", "not a psychological assessment" in v["safety_note"].lower())

    # --- 2. Consent gates every write -------------------------------------
    print("\n[2] Consent gating (all scopes default to OFF)")
    print("-" * 78)
    consent = requests.get(f"{B}/consent", timeout=15).json()
    print(f"      defaults: {consent['consent']}")
    check("all consent defaults to False",
          all(v_ is False for v_ in consent["consent"].values()))

    r = requests.post(f"{B}/baseline", json={"sleep": 7, "mood": 6}, timeout=15).json()
    check("baseline write refused without consent", r["success"] is False, r.get("error", ""))

    r = requests.post(f"{B}/checkin", json={"mood": 6}, timeout=15).json()
    check("check-in write refused without consent", r["success"] is False)

    r = requests.post(f"{B}/ingest", json={"emotion_dominant": "happy"}, timeout=15).json()
    check("signal ingest refused without consent", r.get("stored") is False, r.get("reason", ""))

    after = view()
    check("refused writes stored nothing", after["counts"]["checkins"] == 0
          and after["counts"]["sessions"] == 0)

    # --- 3. Baseline builds only from real submissions --------------------
    print("\n[3] Real baseline + check-ins")
    print("-" * 78)
    set_consent("baseline", True)
    set_consent("checkins", True)
    set_consent("emotion_signals", True)

    r = requests.post(f"{B}/baseline", json={
        "sleep": 7, "energy": 6, "mood": 6, "routine": 7,
        "social_interaction": 5, "communication": 6,
        "preferred_checkin_time": "Evening",
    }, timeout=15).json()
    print(f"      baseline submitted: {r}")
    check("baseline accepted with consent", r["success"] is True)

    v = view()
    print(f"      after questionnaire only: {v['baseline']['status_label']}")
    check("one questionnaire alone is NOT a finished baseline",
          v["baseline"]["status"] == "building")
    check("questionnaire submission recorded",
          v["baseline"]["questionnaire_submitted"] is True)
    check("still asks for more check-ins", v["baseline"]["checkins_needed"] > 0)

    # Add real check-ins.
    for i, mood in enumerate([6, 6, 5, 6]):
        requests.post(f"{B}/checkin", json={
            "sleep": 7 - i * 0.2, "energy": 6, "mood": mood,
            "routine": 7, "social_interaction": 5, "communication": 6,
        }, timeout=15)

    v = view()
    print(f"      after 4 check-ins: status={v['baseline']['status']}"
          f" confidence={v['baseline']['confidence']} dots={v['baseline']['confidence_dots']}")
    check("baseline becomes ready with enough real check-ins",
          v["baseline"]["status"] == "ready")
    check("confidence rose above zero", v["baseline"]["confidence"] > 0)
    check("confidence dots between 0 and 5", 0 <= v["baseline"]["confidence_dots"] <= 5)
    check("self-report modality now available",
          v["modality_status"]["self_report"] == "available")
    check("current state now available", v["current"]["available"] is True)

    # Face/voice/text still have no data - must stay Insufficient.
    check("face still Insufficient (no session yet)",
          v["modality_status"]["face"] == "Insufficient signal")
    check("voice still Insufficient", v["modality_status"]["voice"] == "Insufficient signal")

    # --- 4. Ingestion from the emotion dashboard --------------------------
    print("\n[4] Signal ingestion from the existing dashboard")
    print("-" * 78)
    r = requests.post(f"{B}/ingest", json={
        "emotion_dominant": "neutral", "emotion_confidence": 71.0,
        "emotion_scores": {"neutral": 71, "happy": 12, "sad": 8, "angry": 3,
                           "fear": 3, "surprise": 2, "disgust": 1},
        "sentiment_dominant": "neutral",
        "sentiment_scores": {"positive": 22, "neutral": 58, "negative": 20},
        "voice_available": True, "text_available": False,
        "modalities": ["face", "voice"], "reliability": 82.0,
    }, timeout=15).json()
    print(f"      ingest: {r}")
    check("signal stored with consent", r["stored"] is True)

    v = view()
    print(f"      modality status: {v['modality_status']}")
    check("face modality now available", v["modality_status"]["face"] == "available")
    check("voice modality now available", v["modality_status"]["voice"] == "available")
    check("text stays Insufficient (not sent)",
          v["modality_status"]["text"] == "Insufficient signal")
    check("current emotion reflects the ingested signal",
          v["current"]["emotion"]["dominant"] == "neutral")

    # --- 5. Trends omit empty windows rather than zero-filling ------------
    print("\n[5] Trends")
    print("-" * 78)
    t = requests.get(f"{B}/trends", timeout=20).json()
    for name, w in t["windows"].items():
        print(f"      {name:10s} checkins={w['checkin_count']:3d} sessions={w['session_count']:3d}"
              f" self_report_available={w['self_report']['available']}")
    check("all four windows present", set(t["windows"]) == {"today", "yesterday", "7d", "30d"})
    check("7d window has our real check-ins", t["windows"]["7d"]["checkin_count"] >= 4)
    series = t["series"]
    check("series only contains days with data",
          all(p["points"] > 0 for p in series["self_report"]))
    check("no zero-filled days", all(p["value"] is not None for p in series["self_report"]))

    # --- 6. No synthetic data can reach the personal twin -----------------
    print("\n[6] No fabricated or demo data in the personal twin")
    print("-" * 78)
    blob = str(view()) + str(t)
    hits = [m for m in SYNTHETIC_MARKERS if m in blob]
    check("no demo profile identifiers present", not hits, str(hits))

    export = requests.get(f"{B}/privacy/export", timeout=20).json()["export"]
    check("export contains only our real check-ins",
          len(export["checkins"]) == 4, str(len(export["checkins"])))
    check("export contains only our real signal", len(export["signal_observations"]) == 1)
    check("export states raw media is never stored",
          "never stored" in export["note"].lower())

    # --- 7. Privacy centre -------------------------------------------------
    print("\n[7] Privacy centre")
    print("-" * 78)
    p = requests.get(f"{B}/privacy", timeout=15).json()
    print(f"      stored: {p['stored']['checkins']} check-ins, "
          f"{p['stored']['signal_observations']} signals")
    check("raw media flagged as not stored", p["stored"]["raw_media_stored"] is False)
    check("transcript text flagged as not stored",
          p["stored"]["transcript_text_stored"] is False)
    check("collection purpose stated", bool(p["why"]))
    check("never-stored list includes video and audio",
          any("video" in x.lower() for x in p["what_we_never_store"])
          and any("audio" in x.lower() for x in p["what_we_never_store"]))

    # --- 8. Withdrawal + deletion -----------------------------------------
    print("\n[8] Consent withdrawal and deletion")
    print("-" * 78)
    set_consent("emotion_signals", False)
    r = requests.post(f"{B}/ingest", json={"emotion_dominant": "happy"}, timeout=15).json()
    check("ingest stops immediately after withdrawal", r["stored"] is False)

    deleted = requests.delete(f"{B}/privacy/all", timeout=15).json()
    print(f"      deleted: {deleted['deleted']}")
    final = view()
    check("all data deleted", final["counts"]["checkins"] == 0
          and final["counts"]["sessions"] == 0)
    check("consent revoked on delete-all",
          all(v_ is False for v_ in final["consent"].values()))
    check("twin returns to honest empty state",
          final["baseline"]["status_label"] == "Baseline building...")

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
