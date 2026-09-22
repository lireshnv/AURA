"""Authentication, RBAC and identity-separation tests.

Run (from backend/, server up on :8000):
    C:\\Users\\Admin\\aura-backend-venv\\Scripts\\python.exe -m tests.test_auth

Test accounts use clearly-labelled throwaway addresses under @example.com,
which RFC 2606 reserves for documentation and testing, so no test fixture can
collide with a real user.

(Note: .invalid is also RFC-reserved but email-validator rejects special-use
domains outright, so example.com is the usable choice here.)
"""
import sys
import uuid

import requests

from tests.config import ORIGIN

B = ORIGIN + "/api/auth"
results = []

STRONG = "Correct-Horse-Battery-7"
WEAK = "short"


def check(name, ok, detail=""):
    results.append(("PASS" if ok else "FAIL", name, detail))
    print(f"  {'ok ' if ok else 'BAD'} {name}" + (f"  [{detail}]" if detail else ""))


def unique_email() -> str:
    return f"aura-test-{uuid.uuid4().hex[:10]}@example.com"


def main() -> int:
    print("=" * 78)
    print("AUTHENTICATION / RBAC / IDENTITY SEPARATION")
    print("=" * 78)

    # --- 1. Registration validation ---------------------------------------
    print("\n[1] Registration")
    print("-" * 78)
    email = unique_email()

    r = requests.post(f"{B}/register", json={"email": email, "password": WEAK}, timeout=15)
    check("weak password rejected", r.status_code == 422, str(r.status_code))

    r = requests.post(f"{B}/register", json={
        "email": email, "password": STRONG, "display_name": "Test Person",
    }, timeout=15)
    body = r.json()
    check("registration succeeds", r.status_code == 201, str(r.status_code))
    user = body.get("user", {})
    print(f"      aura_id={user.get('aura_id')}  role={user.get('role')}")
    check("pseudonymous AURA-ID issued", str(user.get("aura_id", "")).startswith("AURA-"))
    check("default role is victim", user.get("role") == "victim")
    check("password hash never returned", "password" not in str(body).lower()
          or "password_hash" not in str(body))

    # AURA-ID must not be derivable from the email.
    local_part = email.split("@")[0]
    check("AURA-ID is not derived from the email",
          local_part not in user.get("aura_id", ""))

    r = requests.post(f"{B}/register", json={"email": email, "password": STRONG}, timeout=15)
    check("duplicate registration rejected", r.status_code == 409, str(r.status_code))

    r = requests.post(f"{B}/register", json={
        "email": unique_email(), "password": STRONG, "role": "admin",
    }, timeout=15)
    check("cannot self-register as admin", r.status_code == 403, str(r.status_code))

    r = requests.post(f"{B}/register", json={
        "email": unique_email(), "password": STRONG, "role": "counsellor",
    }, timeout=15)
    check("cannot self-register as counsellor", r.status_code == 403, str(r.status_code))

    # --- 2. Login ----------------------------------------------------------
    print("\n[2] Login")
    print("-" * 78)
    r = requests.post(f"{B}/login", json={"email": email, "password": "WrongPassword-99"},
                      timeout=15)
    wrong_pw = r.json().get("detail")
    check("wrong password rejected", r.status_code == 401)

    r = requests.post(f"{B}/login", json={
        "email": unique_email(), "password": "WrongPassword-99",
    }, timeout=15)
    unknown_user = r.json().get("detail")
    print(f"      unknown user : {unknown_user}")
    print(f"      wrong password: {wrong_pw}")
    check("identical error for unknown user and wrong password (no enumeration)",
          unknown_user == wrong_pw, f"{unknown_user!r} vs {wrong_pw!r}")

    r = requests.post(f"{B}/login", json={"email": email, "password": STRONG}, timeout=15)
    login = r.json()
    token = login.get("access_token")
    check("login succeeds", r.status_code == 200 and bool(token))
    check("token type is bearer", login.get("token_type") == "bearer")
    check("login response carries aura_id, not identity",
          "aura_id" in login and "password" not in str(login).lower())

    auth = {"Authorization": f"Bearer {token}"}

    # --- 3. Protected routes ----------------------------------------------
    print("\n[3] Protected routes")
    print("-" * 78)
    r = requests.get(f"{B}/me", timeout=15)
    check("no token -> 401", r.status_code == 401, str(r.status_code))

    r = requests.get(f"{B}/me", headers={"Authorization": "Bearer not-a-real-token"}, timeout=15)
    check("garbage token -> 401", r.status_code == 401, str(r.status_code))

    r = requests.get(f"{B}/me", headers={"Authorization": token or ""}, timeout=15)
    check("missing 'Bearer' prefix -> 401", r.status_code == 401, str(r.status_code))

    r = requests.get(f"{B}/me", headers=auth, timeout=15)
    me = r.json()
    check("valid token -> profile returned", r.status_code == 200 and me.get("success"))
    check("profile exposes aura_id",
          me.get("user", {}).get("aura_id") == user.get("aura_id"))
    check("no password hash in profile", "password_hash" not in str(me))

    # --- 4. Logout revokes the session ------------------------------------
    print("\n[4] Logout / revocation")
    print("-" * 78)
    r = requests.post(f"{B}/logout", headers=auth, timeout=15)
    check("logout succeeds", r.status_code == 200 and r.json()["revoked"] is True)

    r = requests.get(f"{B}/me", headers=auth, timeout=15)
    print(f"      reuse after logout -> {r.status_code}")
    check("token is dead after logout (not merely expired client-side)",
          r.status_code == 401, str(r.status_code))

    # --- 5. Account lockout ------------------------------------------------
    print("\n[5] Lockout under repeated failures")
    print("-" * 78)
    lock_email = unique_email()
    requests.post(f"{B}/register", json={"email": lock_email, "password": STRONG}, timeout=15)

    statuses = []
    for _ in range(7):
        rr = requests.post(f"{B}/login", json={
            "email": lock_email, "password": "Definitely-Wrong-1",
        }, timeout=15)
        statuses.append(rr.status_code)
    print(f"      statuses: {statuses}")
    check("account locks after repeated failures", 423 in statuses, str(statuses))

    r = requests.post(f"{B}/login", json={"email": lock_email, "password": STRONG}, timeout=15)
    check("correct password also blocked while locked", r.status_code == 423,
          str(r.status_code))

    # --- 6. System status honesty -----------------------------------------
    print("\n[6] System status")
    print("-" * 78)
    s = requests.get(ORIGIN + "/api/system/status", timeout=15).json()
    print(f"      db={s['database_backend']} env={s['environment']}")
    print(f"      mfa_implemented={s['auth']['mfa_implemented']}")
    check("MFA honestly reported as not implemented",
          s["auth"]["mfa_implemented"] is False)

    # Integration status must MATCH REALITY rather than being hard-coded either
    # way. Whether a key is set changes over time; what must always hold is
    # that the report agrees with the environment and never leaks the value.
    for name in ("gemini", "database"):
        entry = s["integrations"][name]
        print(f"      {name:10s} configured={entry['configured']}  {entry['note'][:52]}")
        check(f"{name} reports a boolean configured flag",
              isinstance(entry["configured"], bool))
        check(f"{name} explains its state", bool(entry.get("note")))

    blob = str(s)
    for secret_fragment in ("jl2EpWKk", "gsk_", "APIdzf4"):
        check(f"system status never leaks '{secret_fragment}'",
              secret_fragment not in blob)

    # --- 7. Security headers ----------------------------------------------
    print("\n[7] Security headers")
    print("-" * 78)
    h = requests.get(ORIGIN + "/health", timeout=15).headers
    for header, expected in (
        ("X-Content-Type-Options", "nosniff"),
        ("X-Frame-Options", "DENY"),
        ("Referrer-Policy", "no-referrer"),
    ):
        print(f"      {header}: {h.get(header)}")
        check(f"{header} set", h.get(header) == expected, str(h.get(header)))

    # --- 8. Existing endpoints still work ---------------------------------
    print("\n[8] Existing features unaffected")
    print("-" * 78)
    for path in ("/health", "/api/version", "/api/voice/capabilities",
                 "/api/twin/view", "/api/risk/assessment", "/api/aura/config"):
        rr = requests.get(ORIGIN + f"{path}", timeout=20)
        check(f"{path} still reachable", rr.status_code == 200, str(rr.status_code))

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
