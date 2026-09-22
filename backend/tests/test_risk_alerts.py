"""Tests for Risk Forecasting + Explainable Alerts.

Run (from backend/, server up on :8000):
    C:\\Users\\Admin\\aura-backend-venv\\Scripts\\python.exe -m tests.test_risk_alerts

Deletes twin data at start/finish - development instances only.

The assertions that matter most: no score without real data, RED never
escalates outside the dashboard, every human action is audited, and the audit
log cannot be edited.
"""
import sys

import requests

from tests.config import ORIGIN

BASE = ORIGIN
TWIN = f"{BASE}/api/twin"
RISK = f"{BASE}/api/risk"
results = []

BANNED = ["detected depression", "has depression", "is depressed", "diagnos", "mentally ill"]


def check(name, ok, detail=""):
    results.append(("PASS" if ok else "FAIL", name, detail))
    print(f"  {'ok ' if ok else 'BAD'} {name}" + (f"  [{detail}]" if detail else ""))


def wipe():
    requests.delete(f"{TWIN}/privacy/all", timeout=15)


def consent(scope, granted=True):
    requests.post(f"{TWIN}/consent", json={"scope": scope, "granted": granted}, timeout=15)


def main() -> int:
    print("=" * 78)
    print("RISK FORECASTING + EXPLAINABLE ALERTS")
    print("=" * 78)

    wipe()

    # --- 1. No data -> no score -------------------------------------------
    print("\n[1] No data: must not calculate")
    print("-" * 78)
    a = requests.get(f"{RISK}/assessment", timeout=20).json()
    print(f"      status={a['status']} reason={a['reason']}")
    check("available False with no data", a["available"] is False)
    check("distress signal is null, not 0", a["distress_signal"] is None)
    check("confidence is null, not 0", a["confidence"] is None)
    check("reason is 'Insufficient data to calculate.'",
          a["reason"] == "Insufficient data to calculate.")
    check("all modalities report Insufficient signal",
          all(m["note"] == "Insufficient signal"
              for k, m in a["modalities"].items() if k != "self_report"))
    check("no human review triggered on empty data",
          a["human_review_required"] is False)
    check("disclaimer present", "not a clinical diagnosis" in a["disclaimer"].lower())

    h = requests.get(f"{RISK}/history", timeout=20).json()
    check("history unavailable with no data", h["available"] is False)
    check("history has no fabricated points", h["points"] == [])

    # --- 2. Build real data ------------------------------------------------
    print("\n[2] Real check-ins + ingested signals")
    print("-" * 78)
    consent("baseline")
    consent("checkins")
    consent("emotion_signals")

    requests.post(f"{TWIN}/baseline", json={
        "sleep": 7, "energy": 7, "mood": 7, "routine": 7,
        "social_interaction": 6, "communication": 7,
    }, timeout=15)

    # A declining self-report pattern, entered as real check-ins.
    for mood, sleep in [(7, 7), (7, 7), (6, 6), (5, 5), (4, 4), (4, 3)]:
        requests.post(f"{TWIN}/checkin", json={
            "sleep": sleep, "energy": mood, "mood": mood, "routine": 6,
            "social_interaction": 5, "communication": 6,
        }, timeout=15)

    # Ingested signals with rising negative sentiment.
    for neg in [20, 30, 45, 60]:
        requests.post(f"{TWIN}/ingest", json={
            "emotion_dominant": "sad", "emotion_confidence": 64.0,
            "emotion_scores": {"sad": 64, "neutral": 20, "happy": 6, "angry": 4,
                               "fear": 4, "surprise": 1, "disgust": 1},
            "sentiment_dominant": "negative",
            "sentiment_scores": {"positive": 10, "neutral": 90 - neg, "negative": neg},
            "voice_available": True, "text_available": True,
            "modalities": ["face", "voice", "text"], "reliability": 78.0,
        }, timeout=15)

    a = requests.get(f"{RISK}/assessment", timeout=20).json()
    print(f"      status={a['status']} ({a['status_label']})")
    print(f"      distress={a['distress_signal']} confidence={a['confidence']} band={a['band']}")
    check("assessment now available", a["available"] is True)
    check("distress signal is a real number", isinstance(a["distress_signal"], (int, float)))
    check("confidence is a real number", isinstance(a["confidence"], (int, float)))
    check("band is one of GREEN/AMBER/RED", a["band"] in ("GREEN", "AMBER", "RED"))

    # --- 3. Explainability -------------------------------------------------
    print("\n[3] Explainable alert")
    print("-" * 78)
    for c in a["contributions"]:
        print(f"      {c['signal']:18s} {c['strength']:7s} "
              f"value={c['value']} weight={c['weight']} available={c['available']}")
    check("all four contribution rows present", len(a["contributions"]) == 4)
    check("strengths use HIGH/MEDIUM/LOW/NONE",
          all(c["strength"] in ("HIGH", "MEDIUM", "LOW", "NONE") for c in a["contributions"]))
    check("weights match the 40/25/20/15 split",
          {c["signal"]: c["weight"] for c in a["contributions"]}
          == {"Self-report": 0.40, "Sentiment": 0.25,
              "Face / behaviour": 0.20, "Engagement": 0.15})

    print("\n      baseline vs current:")
    for c in a["comparison"]:
        arrow = {"up": "^", "down": "v", "flat": "-"}[c["direction"]]
        print(f"        {c['dimension']:20s} base={c['baseline']:5.1f} "
              f"now={c['current']:5.1f} {arrow} ({c['delta']:+.1f})")
    check("baseline vs current comparison provided", len(a["comparison"]) > 0)
    check("contributing factors listed", len(a["contributing_factors"]) > 0)
    check("limitations always stated", len(a["limitations"]) > 0)

    # --- 4. Modality confidence + consistency ------------------------------
    print("\n[4] Modality confidence and consistency")
    print("-" * 78)
    for name, m in a["modalities"].items():
        print(f"      {name:12s} available={m['available']} obs={m['observations']}")
    check("face modality now available", a["modalities"]["face"]["available"] is True)
    check("voice modality now available", a["modalities"]["voice"]["available"] is True)

    cons = a["consistency"]
    print(f"      consistency: {cons}")
    check("consistency evaluated with enough sessions", cons["available"] is True)
    check("consistency reports a label", bool(cons.get("label")))

    # --- 5. RED must not escalate outside the dashboard --------------------
    print("\n[5] Escalation safety")
    print("-" * 78)
    print(f"      {a['escalation_note']}")
    check("autonomous_action is False", a["autonomous_action"] is False)
    check("escalation note rules out contacting police/emergency/family",
          all(w in a["escalation_note"].lower()
              for w in ("police", "emergency", "family")))
    check("escalation note says dashboard only",
          "dashboard" in a["escalation_note"].lower())

    # --- 6. Distress history ----------------------------------------------
    print("\n[6] Distress history graph")
    print("-" * 78)
    h = requests.get(f"{RISK}/history", params={"days": 7}, timeout=30).json()
    print(f"      available={h['available']} points={len(h['points'])}")
    for p in h["points"]:
        print(f"        {p['date']}  {p['value']:5.1f}  {p['band']}")
    check("history points carry real values",
          all(isinstance(p["value"], (int, float)) for p in h["points"]))
    check("no zero-filled days", all(p["value"] is not None for p in h["points"]))

    # --- 7. Human review + audit log --------------------------------------
    print("\n[7] Human review and audit log")
    print("-" * 78)
    r = requests.post(f"{RISK}/review", json={
        "aura_id": "local-user", "action": "support_requested",
        "actor_role": "user", "reason": "Pattern change noticed",
    }, timeout=15).json()
    print(f"      support request: {r['note']}")
    check("user support request recorded", r["success"] is True)
    check("response confirms nobody was contacted",
          "no external party" in r["note"].lower())

    r2 = requests.post(f"{RISK}/review", json={
        "aura_id": "local-user", "action": "risk_reviewed",
        "actor_role": "counsellor", "actor_id": "demo-officer",
        "reason": "Reviewed signals and baseline comparison",
    }, timeout=15).json()
    check("counsellor review recorded", r2["success"] is True)
    print(f"      review status: {r2['review_status']}")
    check("review status reflects the action",
          r2["review_status"]["status"] == "Reviewed")

    bad = requests.post(f"{RISK}/review", json={
        "aura_id": "local-user", "action": "delete_everything", "actor_role": "counsellor",
    }, timeout=15).json()
    check("unknown audit action rejected", bad["success"] is False)

    anon = requests.post(f"{RISK}/review", json={
        "aura_id": "local-user", "action": "risk_reviewed", "actor_role": "  ",
    }, timeout=15).json()
    check("action without an accountable role rejected", anon["success"] is False)

    log = requests.get(f"{RISK}/audit", timeout=15).json()
    print(f"      audit entries: {len(log['entries'])}")
    for e in log["entries"][:3]:
        print(f"        {e['timestamp'][11:19]}  {e['aura_id']}  {e['action']:20s} "
              f"{e['actor_role']}")
    check("audit entries written", len(log["entries"]) >= 2)
    check("audit log declares itself append-only",
          "append-only" in log["note"].lower())
    check("audit entries carry no personal identifiers",
          all(not any(k in e for k in ("name", "email", "phone")) for e in log["entries"]))

    denied = requests.get(f"{RISK}/audit", headers={"x-aura-role": "victim"}, timeout=15).json()
    check("audit log denied to unauthorised role", denied["success"] is False)

    # --- 8. Safety language ------------------------------------------------
    print("\n[8] Safety language")
    print("-" * 78)
    blob = str(a).lower()
    hits = [w for w in BANNED if w in blob and "not a clinical diagnos" not in blob[
        max(0, blob.find(w) - 40): blob.find(w) + 40
    ]]
    check("no diagnostic claims in the assessment", not hits, str(hits))
    check("status wording is non-clinical",
          a["status"] in ("STABLE", "IMPROVING", "CHANGING", "NEEDS_REVIEW", "BUILDING"))

    wipe()
    after = requests.get(f"{RISK}/assessment", timeout=20).json()
    check("returns to honest empty state after deletion",
          after["available"] is False and after["distress_signal"] is None)

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
