"""Tests for the integrated AURA Companion (ported from the `moni` chatbot).

Run (from backend/, server up on :8000):
    C:\\Users\\Admin\\aura-backend-venv\\Scripts\\python.exe -m tests.test_chat

Live Groq round-trips only run when GROQ_API_KEY is set; without it the test
verifies that the service degrades honestly instead of pretending to work.
"""
import os
import sys
import uuid

import requests

from tests.config import ORIGIN

B = ORIGIN + "/api/chat"
results = []


def check(name, ok, detail=""):
    results.append(("PASS" if ok else "FAIL", name, detail))
    print(f"  {'ok ' if ok else 'BAD'} {name}" + (f"  [{detail}]" if detail else ""))


def main() -> int:
    print("=" * 78)
    print("AURA COMPANION - INTEGRATION")
    print("=" * 78)

    # --- 1. Status / configuration honesty ---------------------------------
    print("\n[1] Companion status")
    print("-" * 78)
    s = requests.get(f"{B}/status", timeout=15).json()
    print(f"      groq_installed={s['groq_installed']} key={s['api_key_configured']} "
          f"ready={s['ready']}")
    print(f"      model={s['model']}  web_search={s['web_search_available']}")
    check("status endpoint responds", s["success"] is True)
    check("preserves the original model", s["model"] == "openai/gpt-oss-120b")
    check("groq library installed", s["groq_installed"] is True)
    check("web search preserved", s["web_search_available"] is True)
    check("safety layer enabled", s["safety_layer"] == "enabled")

    blob = str(s)
    check("no API key leaked in status", "gsk_" not in blob and "GROQ_API_KEY=" not in blob)

    configured = s["api_key_configured"]
    if not configured:
        check("reports not-ready honestly when key absent", s["ready"] is False)

    # --- 2. Validation -----------------------------------------------------
    print("\n[2] Input validation")
    print("-" * 78)
    r = requests.post(B, json={"message": ""}, timeout=20)
    check("empty message rejected", r.status_code == 422, str(r.status_code))

    r = requests.post(B, json={"message": "x" * 5000}, timeout=20)
    check("oversized message rejected", r.status_code == 422, str(r.status_code))

    r = requests.post(B, json={}, timeout=20)
    check("missing message rejected", r.status_code == 422, str(r.status_code))

    # --- 3. Session isolation ---------------------------------------------
    print("\n[3] Sessions")
    print("-" * 78)
    new = requests.post(f"{B}/new", timeout=15).json()
    session_a = new["session_id"]
    check("new conversation returns a session id", bool(session_a))
    check("empty state message is correct",
          new["empty_state"] == "Start a conversation with AURA.")

    hist = requests.get(f"{B}/history", params={"session_id": session_a}, timeout=15).json()
    check("new session has no messages", hist["messages"] == [])
    check("empty history advertises the empty state",
          hist["empty_state"] == "Start a conversation with AURA.")

    session_b = requests.post(f"{B}/new", timeout=15).json()["session_id"]
    check("second session id differs", session_a != session_b)

    # A session id that was never created must return empty, not error or leak.
    stranger = requests.get(f"{B}/history", params={"session_id": str(uuid.uuid4())},
                            timeout=15).json()
    check("unknown session returns empty, leaks nothing", stranger["messages"] == [])

    # --- 4. Error handling without leakage ---------------------------------
    print("\n[4] Error handling")
    print("-" * 78)
    r = requests.post(B, json={"message": "Hello AURA"}, timeout=90)
    body = r.json()
    print(f"      status={body.get('status')} reply={str(body.get('response'))[:60]!r}")
    check("request always returns a structured reply", r.status_code == 200)
    check("status is one of success/unavailable/error",
          body.get("status") in ("success", "unavailable", "error"))

    reply_text = str(body.get("response", ""))
    for leak in ("Traceback", "gsk_", "api_key", "GROQ_API_KEY", "groq.com",
                 "File \"", "line "):
        check(f"reply does not leak '{leak}'", leak not in reply_text)

    if not configured:
        check("unconfigured service returns the safe user message",
              reply_text == "Sorry, I'm temporarily unavailable. Please try again.",
              reply_text[:50])
        check("status reflects unavailability", body.get("status") == "unavailable")

    # --- 5. Crisis safety layer (deterministic, model-independent) ---------
    print("\n[5] Crisis safety layer")
    print("-" * 78)
    sys.path.insert(0, os.getcwd())
    from app.services import chat_safety

    # Both contracted AND expanded negations. The expanded forms were a real
    # live-testing miss: "don't want to live" matched while "do not want to
    # live" did not, and speech-to-text routinely expands contractions.
    crisis_cases = [
        ("I want to kill myself", "self_harm"),
        ("I don't want to live anymore", "self_harm"),
        ("I do not want to live anymore", "self_harm"),
        ("I dont want to be here", "self_harm"),
        ("I have been thinking about suicide", "self_harm"),
        ("I wish I was dead", "self_harm"),
        ("I cannot go on", "self_harm"),
        ("I can't take this anymore", "self_harm"),
        ("There is nothing to live for", "self_harm"),
        ("he is outside and going to hurt me", "immediate_danger"),
        ("he's here and has a knife", "immediate_danger"),
        ("he is coming for me right now", "immediate_danger"),
        ("I am not safe", "immediate_danger"),
        ("I'm in danger", "immediate_danger"),
        ("I took too many pills", "medical_emergency"),
        ("I cannot breathe", "medical_emergency"),
    ]
    for text, expected in crisis_cases:
        res = chat_safety.check_message(text)
        print(f"      {text[:42]:44s} -> {res.categories} ({res.severity})")
        check(f"detects: {text[:28]}", res.triggered and expected in res.categories,
              str(res.categories))
        check(f"resources attached: {text[:20]}", len(res.resources) > 0)

    benign = [
        "I had a difficult day at work today",
        "I have been feeling sad and tired lately",
        "I spoke to my therapist about it",
        "The assistant was helpful",
        "I feel hopeless about the court case",
        "I do not want to talk about it today",
        "I cannot remember what happened next",
        "He is coming to the hearing next week",
        "She is coming to visit me on Sunday",
        "They are coming to collect the documents",
        "I don't want to eat anything",
    ]
    for text in benign:
        res = chat_safety.check_message(text)
        print(f"      {text[:42]:44s} -> {'TRIGGER' if res.triggered else 'clear'}")
        check(f"no false positive: {text[:28]}", not res.triggered, str(res.categories))

    # The classic substring traps.
    check("'therapist' does not match 'the rapist'",
          not chat_safety.check_message("I saw my therapist").triggered)
    check("empty message does not trigger", not chat_safety.check_message("").triggered)

    # --- 6. Safety block reaches the API response --------------------------
    print("\n[6] Safety block surfaces through the API")
    print("-" * 78)
    r = requests.post(B, json={"message": "I want to kill myself"}, timeout=90).json()
    safety = r.get("safety")
    print(f"      safety={'present' if safety else 'ABSENT'}")
    check("crisis message attaches a safety block", safety is not None)
    if safety:
        check("safety block marked triggered", safety.get("triggered") is True)
        check("severity is urgent", safety.get("severity") == "urgent")
        check("resources provided", len(safety.get("resources", [])) > 0)
        check("safety message is supportive, not clinical",
              "danger" in safety["message"].lower() or "support" in safety["message"].lower()
              or "glad you told me" in safety["message"].lower())

    # Crucially: the safety block appears even when the model is unavailable,
    # because it is computed independently of the model.
    if not configured:
        check("safety block present even when the model is unavailable",
              safety is not None)

    # --- 7. Clear conversation ---------------------------------------------
    print("\n[7] Clearing a conversation")
    print("-" * 78)
    r = requests.delete(f"{B}/{session_a}", timeout=15).json()
    check("clear returns success", r["success"] is True)
    hist = requests.get(f"{B}/history", params={"session_id": session_a}, timeout=15).json()
    check("conversation is empty after clearing", hist["messages"] == [])

    # --- 8. Live Groq round trip (only with a real key) --------------------
    print("\n[8] Live Groq round trip")
    print("-" * 78)
    if not configured:
        print("      SKIPPED - GROQ_API_KEY is not set on the backend.")
        print("      Set it in backend/.env to verify the full path to Groq.")
    else:
        r = requests.post(B, json={"message": "Hello, can you hear me?"}, timeout=90).json()
        print(f"      status={r['status']}  reply={r['response'][:70]!r}")
        check("live reply received", r["status"] == "success" and len(r["response"]) > 0)
        sid = r["session_id"]
        r2 = requests.post(B, json={"message": "What did I just say?", "session_id": sid},
                           timeout=90).json()
        check("conversation context preserved across turns", r2["status"] == "success")
        hist = requests.get(f"{B}/history", params={"session_id": sid}, timeout=15).json()
        check("history persisted for the session", len(hist["messages"]) >= 2)

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
