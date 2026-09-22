"""AURA platform tests: real-data-only twin, case queue and support.

Run (from backend/, server up on :8000):
    C:\\Users\\Admin\\aura-backend-venv\\Scripts\\python.exe -m tests.test_aura_platform

Rewritten after the demo/synthetic data module was deleted. The core assertion
is now the inverse of what it used to be: with no real data the platform must
report absence, and it must never invent a profile, a score or a case.

Deletes twin data at start/finish - development instances only.
"""
import sys

import requests

from tests.config import ORIGIN

BASE = ORIGIN
AURA = f"{BASE}/api/aura"
TWIN = f"{BASE}/api/twin"
results = []

# Identifiers from the deleted demo module. None may ever reappear.
REMOVED_DEMO_MARKERS = [
    "AURA-1042", "AURA-2178", "AURA-3315",
    "Victim A", "Victim B", "Victim C",
    "simulation_stages", "Simulate Change",
]


def check(name, ok, detail=""):
    results.append(("PASS" if ok else "FAIL", name, detail))
    print(f"  {'ok ' if ok else 'BAD'} {name}" + (f"  [{detail}]" if detail else ""))


def wipe():
    requests.delete(f"{TWIN}/privacy/all", timeout=15)


def consent(scope):
    requests.post(f"{TWIN}/consent", json={"scope": scope, "granted": True}, timeout=15)


def main() -> int:
    print("=" * 78)
    print("AURA PLATFORM - REAL DATA ONLY")
    print("=" * 78)

    wipe()

    # --- 1. Demo module is gone -------------------------------------------
    print("\n[1] Demo / synthetic data removed")
    print("-" * 78)
    gone = requests.get(f"{AURA}/demo/profiles", timeout=15)
    check("demo profiles endpoint removed", gone.status_code == 404, str(gone.status_code))

    cfg = requests.get(f"{AURA}/config", timeout=15).json()
    check("config declares synthetic_data false", cfg.get("synthetic_data") is False)

    blob = str(cfg)
    hits = [m for m in REMOVED_DEMO_MARKERS if m in blob]
    check("no demo identifiers in config", not hits, str(hits))

    # --- 2. Empty state: nothing invented ---------------------------------
    print("\n[2] Empty state")
    print("-" * 78)
    q = requests.get(f"{AURA}/cases", timeout=20).json()
    print(f"      cases={len(q['cases'])} message={q.get('message')}")
    check("case queue is empty with no real data", q["cases"] == [])
    check("queue says No data available", q.get("message") == "No data available")
    check("queue flagged non-synthetic", q.get("synthetic") is False)
    check("summary totals are zero", q["summary"]["total"] == 0)

    t = requests.get(f"{AURA}/twin/local-user", timeout=20).json()
    print(f"      twin has_data={t['has_data']} message={t.get('message')}")
    check("twin reports has_data False", t["has_data"] is False)
    check("twin says No data available", t.get("message") == "No data available")
    check("no risk score invented", "risk" not in t)

    sup = requests.get(f"{AURA}/support/pathways/local-user", timeout=20).json()
    check("no support pathways invented", sup.get("suggestions") == [])

    # --- 3. Real data appears once actually recorded ----------------------
    print("\n[3] Real recorded data flows through")
    print("-" * 78)
    consent("baseline")
    consent("checkins")
    consent("emotion_signals")

    requests.post(f"{TWIN}/baseline", json={
        "sleep": 7, "energy": 7, "mood": 7, "routine": 7,
        "social_interaction": 6, "communication": 7,
    }, timeout=15)
    for mood in (7, 6, 6, 5):
        requests.post(f"{TWIN}/checkin", json={
            "sleep": mood, "energy": mood, "mood": mood,
            "routine": 6, "social_interaction": 5, "communication": 6,
        }, timeout=15)

    t = requests.get(f"{AURA}/twin/local-user", timeout=20).json()
    print(f"      has_data={t['has_data']} band={t.get('risk', {}).get('band')} "
          f"checkins={t.get('counts', {}).get('checkins')}")
    check("twin now has data", t["has_data"] is True)
    check("risk computed from real check-ins", "risk" in t)
    check("check-in count matches what was recorded",
          t["counts"]["checkins"] == 4, str(t.get("counts")))
    check("human review always required", t["risk"]["human_review_required"] is True)
    check("no autonomous action", t["risk"]["autonomous_action"] is False)
    check("disclaimer present",
          "not a clinical diagnosis" in t["risk"]["disclaimer"].lower())

    q = requests.get(f"{AURA}/cases", timeout=20).json()
    print(f"      queue now has {len(q['cases'])} case(s)")
    check("real profile appears in the queue", len(q["cases"]) == 1, str(len(q["cases"])))
    if q["cases"]:
        case = q["cases"][0]
        check("case is the real local identity", case["aura_id"] == "local-user")
        check("case carries no display name", "display_name" not in case)
        check("case carries no fabricated case stage", "case_stage" not in case)
        check("case counts reflect real records",
              case["counts"]["checkins"] == 4, str(case["counts"]))

    # --- 4. Role enforcement ----------------------------------------------
    print("\n[4] Role enforcement")
    print("-" * 78)
    denied = requests.get(f"{AURA}/cases", headers={"x-aura-role": "victim"}, timeout=15).json()
    check("victim role cannot read the case queue", denied.get("success") is False)

    # --- 5. Support: AI suggests, human decides ---------------------------
    print("\n[5] Support orchestration")
    print("-" * 78)
    sup = requests.get(f"{AURA}/support/pathways/local-user", timeout=20).json()
    for s in sup["suggestions"]:
        print(f"      [{s['status']}] {s['pathway']}")
    check("pathways suggested from real signals", len(sup["suggestions"]) > 0)
    check("all suggestions start as recommended",
          all(s["status"] == "recommended" for s in sup["suggestions"]))
    check("all require human approval",
          all(s["requires_human_approval"] for s in sup["suggestions"]))

    unattributed = requests.post(f"{AURA}/support/decision", json={
        "aura_id": "local-user", "pathway": "Counselling",
        "decision": "approved", "decided_by": "  ",
    }, timeout=15).json()
    check("decision without an accountable human is rejected",
          unattributed.get("success") is False)

    ok = requests.post(f"{AURA}/support/decision", json={
        "aura_id": "local-user", "pathway": "Counselling",
        "decision": "approved", "decided_by": "counsellor:officer-1",
    }, timeout=15).json()
    check("attributed decision recorded", ok.get("success") is True)
    check("decision attributed to a human", ok["recorded"]["decided_by_ai"] is False)

    # --- 6. No demo residue anywhere --------------------------------------
    print("\n[6] No demo residue in any response")
    print("-" * 78)
    combined = str(cfg) + str(q) + str(t) + str(sup)
    hits = [m for m in REMOVED_DEMO_MARKERS if m in combined]
    check("no demo identifiers in any payload", not hits, str(hits))

    # --- 7. Deleting data returns the platform to empty --------------------
    print("\n[7] Deletion returns the platform to empty")
    print("-" * 78)
    wipe()
    q = requests.get(f"{AURA}/cases", timeout=20).json()
    t = requests.get(f"{AURA}/twin/local-user", timeout=20).json()
    check("queue empty again after deletion", q["cases"] == [])
    check("twin reports no data again", t["has_data"] is False)

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
