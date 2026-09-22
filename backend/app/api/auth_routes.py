"""Authentication, registration and session endpoints."""
import hashlib
import logging
import secrets
import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from threading import Lock
from typing import Deque, Dict, Optional

from fastapi import APIRouter, Cookie, Depends, Header, HTTPException, Request, Response, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session

from ..core.config import settings
from ..database import get_db
from ..database.models import AuditLog, AuthSession, CounsellorAssignment, GuardianVictimLink, Profile, User
from ..security.auth import (
    GENERIC_LOGIN_ERROR,
    ROLES,
    clear_failed_logins,
    clear_session_cookies,
    create_access_token,
    generate_aura_id,
    get_current_user,
    hash_password,
    is_locked,
    password_problems,
    register_failed_login,
    require_exact_role,
    require_role,
    revoke_token,
    set_session_cookies,
    verify_csrf,
    verify_password,
)
from ..services import google_oauth, otp_service, password_reset_service

logger = logging.getLogger("aura.auth_api")
router = APIRouter(prefix="/api/auth", tags=["auth"])

# Simple in-process rate limiting for login/OTP endpoints - sufficient for a
# single-instance deployment; a multi-instance one needs a shared store
# (Redis), same caveat as the AI Companion's rate limiter (api/chat.py).
_rate_state: Dict[str, Deque[float]] = defaultdict(lambda: deque(maxlen=20))
_rate_lock = Lock()


def _rate_limited(key: str, limit: int, window_seconds: int) -> bool:
    now = time.time()
    with _rate_lock:
        bucket = _rate_state[key]
        while bucket and now - bucket[0] > window_seconds:
            bucket.popleft()
        if len(bucket) >= limit:
            return True
        bucket.append(now)
    return False


def _token_expiry(token: dict) -> datetime:
    return datetime.fromisoformat(token["expires_at"])


def _dev_log_auth_success(event: str, user: User) -> None:
    """Development-only auth tracing: which step completed, for which
    account - id/aura_id/role only, NEVER a password, OTP code, token, or
    any secret. Silent in production (this is a debugging aid, not an
    audit trail - _audit() above is the real, permanent audit log)."""
    if settings.is_production:
        return
    logger.info(
        "[DEV AUTH] %s | user_id=%s aura_id=%s role=%s", event, user.id, user.aura_id, user.role
    )


# --- Schemas ---------------------------------------------------------------


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=12, max_length=200)
    display_name: Optional[str] = Field(default=None, max_length=120)
    # Self-registration is victim-only. Elevated roles are provisioned by an
    # admin, never claimed by the person signing up.
    role: str = "victim"


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    id: str
    email: EmailStr
    aura_id: str
    role: str
    display_name: Optional[str] = None
    mfa_enabled: bool = False
    onboarding_complete: bool = False


class OnboardingRequest(BaseModel):
    # Free-form short answers to that role's onboarding questions - the
    # frontend supplies the question set per role; this just stores whatever
    # was actually answered (a value the person left blank is simply absent).
    responses: Dict[str, str] = Field(default_factory=dict)


# --- Audit helper ----------------------------------------------------------


def _audit(
    db: Session,
    action: str,
    actor_id: Optional[str],
    actor_role: str,
    request: Optional[Request] = None,
    resource: Optional[str] = None,
    resource_id: Optional[str] = None,
    reason: Optional[str] = None,
) -> None:
    """Writes an audit row.

    The client IP is stored as a salted hash, never in clear: it is enough to
    correlate suspicious activity, without retaining a directly identifying
    network address alongside victim records.
    """
    ip_hash = None
    if request is not None and request.client:
        ip_hash = hashlib.sha256(
            f"aura-audit|{request.client.host}".encode("utf-8")
        ).hexdigest()
    db.add(
        AuditLog(
            actor_id=actor_id,
            actor_role=actor_role,
            action=action,
            resource=resource,
            resource_id=resource_id,
            reason=reason,
            ip_hash=ip_hash,
        )
    )
    db.commit()


# --- Routes ----------------------------------------------------------------


@router.post("/register", status_code=status.HTTP_201_CREATED)
async def register(payload: RegisterRequest, request: Request, db: Session = Depends(get_db)):
    problems = password_problems(payload.password)
    if problems:
        raise HTTPException(status_code=422, detail={"password": problems})

    if payload.role != "victim":
        # Refusing loudly rather than silently downgrading, so a caller cannot
        # believe they created a counsellor account when they did not.
        raise HTTPException(
            status_code=403,
            detail="Only victim accounts can self-register. "
            "Counsellor and admin accounts are provisioned by an administrator.",
        )

    email = payload.email.lower().strip()
    if db.query(User).filter(User.email == email).first():
        # Deliberately the same shape of error as a weak password so this
        # endpoint cannot be used to enumerate registered addresses.
        raise HTTPException(status_code=409, detail="Could not create the account.")

    user = User(
        email=email,
        password_hash=hash_password(payload.password),
        role="victim",
        aura_id=generate_aura_id(),
    )
    db.add(user)
    db.flush()
    db.add(Profile(user_id=user.id, display_name=payload.display_name))
    db.commit()

    _audit(db, "user_registered", user.id, user.role, request, resource="users")

    return {
        "success": True,
        "user": UserOut(
            id=user.id,
            email=user.email,
            aura_id=user.aura_id,
            role=user.role,
            display_name=payload.display_name,
        ).model_dump(),
        "note": "Your AURA-ID is used for all analysis data. Your name is never sent to AI services.",
    }


@router.post("/login")
async def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    user_agent: Optional[str] = Header(default=None),
):
    email = payload.email.lower().strip()

    if _rate_limited(f"login:{email}", limit=10, window_seconds=60):
        raise HTTPException(status_code=429, detail="Too many login attempts. Please wait a moment.")

    user = db.query(User).filter(User.email == email).first()

    # Identical response whether the account exists or the password is wrong.
    if user is None:
        raise HTTPException(status_code=401, detail=GENERIC_LOGIN_ERROR)

    if is_locked(user):
        _audit(db, "login_blocked_locked", user.id, user.role, request, reason="locked")
        raise HTTPException(
            status_code=423,
            detail="Account temporarily locked after repeated failed attempts. "
            "Please try again shortly.",
        )

    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account is not active.")

    if not verify_password(payload.password, user.password_hash):
        register_failed_login(user, db)
        _audit(db, "login_failed", user.id, user.role, request)
        raise HTTPException(status_code=401, detail=GENERIC_LOGIN_ERROR)

    clear_failed_logins(user, db)
    token = create_access_token(user, db, user_agent)
    set_session_cookies(response, token["access_token"], _token_expiry(token))
    _audit(db, "login", user.id, user.role, request)
    _dev_log_auth_success("password login: session created", user)

    return {"success": True, **token}


@router.post("/logout")
async def logout(
    request: Request,
    response: Response,
    authorization: Optional[str] = Header(default=None),
    aura_session: Optional[str] = Cookie(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    clear_session_cookies(response)
    token = (authorization or "").split(None, 1)[-1] or aura_session or ""
    revoked = revoke_token(token, db)
    _audit(db, "logout", user.id, user.role, request)
    return {"success": True, "revoked": revoked}


@router.get("/me")
async def me(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    profile = db.query(Profile).filter(Profile.user_id == user.id).first()
    return {
        "success": True,
        "user": UserOut(
            id=user.id,
            email=user.email,
            aura_id=user.aura_id,
            role=user.role,
            display_name=profile.display_name if profile else None,
            mfa_enabled=user.mfa_enabled,
            onboarding_complete=bool(profile.onboarding_complete) if profile else False,
        ).model_dump(),
    }


# --- OTP login (existing users only) ------------------------------------
#
# The OTP is generated, hashed, stored and verified ENTIRELY server-side
# (see services/otp_service.py). The frontend only ever sends an email to
# request one and a 6-digit code to verify one - it never sees the hash, the
# real code (unless it's reading the backend's own dev console), or any
# stored record.


class OtpRequestRequest(BaseModel):
    email: EmailStr


class OtpVerifyRequest(BaseModel):
    email: EmailStr
    code: str = Field(min_length=4, max_length=8)


@router.post("/otp/request")
async def otp_request(payload: OtpRequestRequest, db: Session = Depends(get_db)):
    email = payload.email.lower().strip()
    if _rate_limited(f"otp-request:{email}", limit=5, window_seconds=300):
        raise HTTPException(status_code=429, detail="Too many code requests. Please wait a moment.")

    user = db.query(User).filter(User.email == email).first()
    # Same generic response whether or not the account exists - this endpoint
    # must not be usable to enumerate registered emails.
    generic = {"success": True, "message": "If that account exists, a code has been sent."}
    if not user or not user.is_active:
        return generic

    sent, reason = otp_service.request_otp(user, db)
    if not sent and reason == "cooldown":
        return {
            "success": True,
            "message": f"A code was already sent recently. Please wait before requesting another.",
        }
    return generic


@router.post("/otp/verify")
async def otp_verify(
    payload: OtpVerifyRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    user_agent: Optional[str] = Header(default=None),
):
    email = payload.email.lower().strip()
    if _rate_limited(f"otp-verify:{email}", limit=10, window_seconds=300):
        raise HTTPException(status_code=429, detail="Too many attempts. Please wait a moment.")

    user = db.query(User).filter(User.email == email).first()
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="Invalid or expired code.")

    ok, reason = otp_service.verify_otp(user, payload.code, db)
    if not ok:
        _audit(db, "otp_failed", user.id, user.role, request, reason=reason)
        detail = {
            "no_code": "No code was requested, or it already expired.",
            "expired": "That code has expired. Request a new one.",
            "too_many_attempts": "Too many incorrect attempts. Request a new code.",
            "invalid_code": "Invalid or expired code.",
        }.get(reason, "Invalid or expired code.")
        raise HTTPException(status_code=401, detail=detail)

    clear_failed_logins(user, db)
    token = create_access_token(user, db, user_agent)
    set_session_cookies(response, token["access_token"], _token_expiry(token))
    _audit(db, "otp_login", user.id, user.role, request)
    _dev_log_auth_success("otp verified: session created", user)
    return {"success": True, **token}


# --- Forgot password (secure, expiring, single-use reset link) ------------
#
# The reset token is generated, hashed, stored and consumed ENTIRELY
# server-side (see services/password_reset_service.py). The frontend only
# ever sends an email to request a link and a token+new-password to
# complete the reset - it never sees the hash or any stored record.


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    token: str = Field(min_length=16, max_length=200)
    new_password: str = Field(min_length=12, max_length=200)


@router.post("/password/forgot")
async def forgot_password(payload: ForgotPasswordRequest, db: Session = Depends(get_db)):
    email = payload.email.lower().strip()
    if _rate_limited(f"pw-forgot:{email}", limit=5, window_seconds=300):
        raise HTTPException(status_code=429, detail="Too many requests. Please wait a moment.")

    user = db.query(User).filter(User.email == email).first()
    # Same generic response whether or not the account exists - this endpoint
    # must not be usable to enumerate registered emails.
    generic = {"success": True, "message": "If that account exists, a reset link has been sent."}
    if not user or not user.is_active:
        return generic

    password_reset_service.request_reset(user, db)
    return generic


@router.post("/password/reset")
async def reset_password(payload: ResetPasswordRequest, request: Request, db: Session = Depends(get_db)):
    if _rate_limited(f"pw-reset:{request.client.host if request.client else 'unknown'}", limit=20, window_seconds=300):
        raise HTTPException(status_code=429, detail="Too many attempts. Please wait a moment.")

    problems = password_problems(payload.new_password)
    if problems:
        raise HTTPException(status_code=422, detail={"password": problems})

    user, reason = password_reset_service.consume_reset_token(payload.token, db)
    if not user:
        detail = {
            "expired": "That reset link has expired. Request a new one.",
            "used": "That reset link has already been used. Request a new one.",
        }.get(reason, "That reset link is invalid. Request a new one.")
        raise HTTPException(status_code=400, detail=detail)

    user.password_hash = hash_password(payload.new_password)
    clear_failed_logins(user, db)
    # Reset revokes every existing session - a stolen active session must not
    # survive a password reset, and this is also what makes a reset useful
    # against a compromised account.
    db.query(AuthSession).filter(
        AuthSession.user_id == user.id, AuthSession.revoked_at.is_(None)
    ).update({"revoked_at": datetime.now(timezone.utc)})
    db.commit()

    _audit(db, "password_reset", user.id, user.role, request)
    _dev_log_auth_success("password reset completed", user)

    return {"success": True, "message": "Password has been reset. Please sign in."}


# --- Google OAuth 2.0 -----------------------------------------------------
#
# The browser is only ever handed a redirect URL. The authorization code
# exchange and ID token signature verification happen entirely in
# services/google_oauth.py, server-side - GOOGLE_CLIENT_SECRET never leaves
# the backend process.


@router.get("/google/login")
async def google_login():
    if not google_oauth.is_configured():
        raise HTTPException(status_code=503, detail="Google sign-in is not configured.")
    url = google_oauth.build_authorization_url()
    return RedirectResponse(url)


@router.get("/google/callback")
async def google_callback(
    request: Request,
    response: Response,
    code: Optional[str] = None,
    state: Optional[str] = None,
    error: Optional[str] = None,
    db: Session = Depends(get_db),
    user_agent: Optional[str] = Header(default=None),
):
    """Google redirects the browser here with `code`+`state` on success.

    On any failure, redirects back to the frontend's login screen with a
    generic error flag rather than a raw error page - no internal detail
    (state mismatch reason, Google's own error text) is exposed to the URL
    the browser ends up on.
    """
    failure_url = f"{settings.frontend_url}/?auth_error=google"

    if error or not code or not state:
        return RedirectResponse(failure_url)

    code_verifier = google_oauth.consume_state(state)
    if not code_verifier:
        logger.warning("Google OAuth callback with unknown/expired/reused state")
        return RedirectResponse(failure_url)

    claims, exchange_error = google_oauth.exchange_code(code, code_verifier)
    if exchange_error or not claims:
        logger.warning("Google OAuth exchange failed: %s", exchange_error)
        return RedirectResponse(failure_url)

    google_sub = claims["sub"]
    email = claims["email"].lower().strip()
    display_name = claims.get("name")

    # Link-or-create: an existing account (by google_sub, or by email if this
    # is their first Google sign-in) is reused - never a second account for
    # the same person.
    user = db.query(User).filter(User.google_sub == google_sub).first()
    if not user:
        user = db.query(User).filter(User.email == email).first()

    if user:
        if not user.is_active:
            return RedirectResponse(failure_url)
        if not user.google_sub:
            user.google_sub = google_sub
            db.commit()
        _audit(db, "login", user.id, user.role, request, reason="google")
        _dev_log_auth_success("google callback: existing account linked/found", user)
    else:
        # New Google sign-in with no matching account: self-registration is
        # victim-only here too, same rule as /register.
        user = User(
            email=email,
            password_hash=hash_password(secrets_password()),
            role="victim",
            aura_id=generate_aura_id(),
            google_sub=google_sub,
        )
        db.add(user)
        db.flush()
        db.add(Profile(user_id=user.id, display_name=display_name))
        db.commit()
        _audit(db, "user_registered", user.id, user.role, request, resource="users", reason="google")
        _dev_log_auth_success("google callback: new account created", user)

    clear_failed_logins(user, db)
    token = create_access_token(user, db, user_agent)
    set_session_cookies(response, token["access_token"], _token_expiry(token))
    _dev_log_auth_success("google callback: session created, redirecting to frontend", user)
    return RedirectResponse(f"{settings.frontend_url}/?auth=google")


def secrets_password() -> str:
    """An unusable random password for Google-only accounts - long enough to
    satisfy password_problems() even though nobody will ever type it; the
    account can only ever be reached via Google sign-in (or an admin resetting
    it) since this value is never returned to anyone."""
    return secrets.token_urlsafe(32)


@router.post("/onboarding")
async def submit_onboarding(
    payload: OnboardingRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Stores the short, role-specific onboarding survey answers this person
    actually gave, and marks onboarding complete so the dashboard stops
    showing it. No question set is enforced server-side - the frontend picks
    the (short) questions for the caller's role; this just persists answers."""
    profile = db.query(Profile).filter(Profile.user_id == user.id).first()
    if not profile:
        profile = Profile(user_id=user.id)
        db.add(profile)
    profile.onboarding_data = payload.responses
    profile.onboarding_complete = True
    db.commit()
    return {"success": True, "onboarding_complete": True}


@router.get("/roles")
async def roles():
    return {
        "success": True,
        "roles": list(ROLES),
        "self_registration": ["victim"],
        "note": "Counsellor, admin and IVRS-support roles are provisioned by an administrator.",
    }


# --- Admin: user + assignment management ------------------------------
#
# Real provisioning, gated by the same JWT/require_role machinery as every
# other protected route - not a second, parallel auth mechanism. Only an
# authenticated admin can reach anything below.


class AdminCreateUserRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=12, max_length=200)
    display_name: Optional[str] = Field(default=None, max_length=120)
    role: str = Field(description="One of: counsellor, admin, guardian")


class AdminUpdateUserRequest(BaseModel):
    role: Optional[str] = None
    is_active: Optional[bool] = None


class AssignmentRequest(BaseModel):
    counsellor_user_id: str
    victim_aura_id: str


def _user_out(user: User, display_name: Optional[str] = None) -> dict:
    return UserOut(
        id=user.id,
        email=user.email,
        aura_id=user.aura_id,
        role=user.role,
        display_name=display_name,
        mfa_enabled=user.mfa_enabled,
    ).model_dump()


@router.post("/admin/users", status_code=status.HTTP_201_CREATED)
async def admin_create_user(
    payload: AdminCreateUserRequest,
    request: Request,
    db: Session = Depends(get_db),
    admin: User = Depends(require_role("admin")),
):
    """Provisions a counsellor, admin, or guardian account. This is the
    ONLY way those roles come into existence - self-registration refuses
    anything but victim (see /register above)."""
    if payload.role not in ("counsellor", "admin", "guardian"):
        raise HTTPException(
            status_code=422, detail="role must be one of: counsellor, admin, guardian."
        )
    problems = password_problems(payload.password)
    if problems:
        raise HTTPException(status_code=422, detail={"password": problems})

    email = payload.email.lower().strip()
    if db.query(User).filter(User.email == email).first():
        raise HTTPException(status_code=409, detail="Could not create the account.")

    user = User(
        email=email,
        password_hash=hash_password(payload.password),
        role=payload.role,
        aura_id=generate_aura_id(),
    )
    db.add(user)
    db.flush()
    db.add(Profile(user_id=user.id, display_name=payload.display_name))
    db.commit()

    _audit(db, "admin_user_created", admin.id, admin.role, request, resource="users", reason=payload.role)

    return {"success": True, "user": _user_out(user, payload.display_name)}


@router.get("/admin/users")
async def admin_list_users(
    db: Session = Depends(get_db), admin: User = Depends(require_role("admin"))
):
    users = db.query(User).order_by(User.created_at.desc()).all()
    out = []
    for u in users:
        profile = db.query(Profile).filter(Profile.user_id == u.id).first()
        out.append(
            {
                **_user_out(u, profile.display_name if profile else None),
                "is_active": u.is_active,
                "last_login_at": u.last_login_at.isoformat() if u.last_login_at else None,
                "created_at": u.created_at.isoformat(),
            }
        )
    return {"success": True, "users": out}


@router.patch("/admin/users/{user_id}")
async def admin_update_user(
    user_id: str,
    payload: AdminUpdateUserRequest,
    request: Request,
    db: Session = Depends(get_db),
    admin: User = Depends(require_role("admin")),
):
    """Changes a user's role or active status. Cannot be used to demote the
    caller's own last admin account into a lockout (would need a second
    admin) - kept simple: an admin may not deactivate or demote themself."""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")
    if user.id == admin.id and (payload.role or payload.is_active is False):
        raise HTTPException(status_code=400, detail="You cannot change your own role or deactivate yourself.")

    if payload.role is not None:
        if payload.role not in ROLES:
            raise HTTPException(status_code=422, detail=f"role must be one of: {', '.join(ROLES)}.")
        user.role = payload.role
    if payload.is_active is not None:
        user.is_active = payload.is_active
    db.commit()

    _audit(db, "admin_user_updated", admin.id, admin.role, request, resource="users", resource_id=user.id)

    return {"success": True, "user": _user_out(user)}


@router.post("/admin/assignments", status_code=status.HTTP_201_CREATED)
async def admin_create_assignment(
    payload: AssignmentRequest,
    request: Request,
    db: Session = Depends(get_db),
    admin: User = Depends(require_role("admin")),
):
    """Authorizes one counsellor to access one victim's (aura_id-scoped)
    well-being/risk data. This is the real relationship the counsellor
    dashboard's victim list is filtered by - not a role check alone."""
    counsellor = db.query(User).filter(User.id == payload.counsellor_user_id).first()
    if not counsellor or counsellor.role != "counsellor":
        raise HTTPException(status_code=422, detail="counsellor_user_id must belong to a counsellor account.")

    existing = (
        db.query(CounsellorAssignment)
        .filter(
            CounsellorAssignment.counsellor_user_id == payload.counsellor_user_id,
            CounsellorAssignment.victim_aura_id == payload.victim_aura_id,
        )
        .first()
    )
    if existing:
        existing.active = True
        db.commit()
        assignment = existing
    else:
        assignment = CounsellorAssignment(
            counsellor_user_id=payload.counsellor_user_id,
            victim_aura_id=payload.victim_aura_id,
            assigned_by_user_id=admin.id,
        )
        db.add(assignment)
        db.commit()

    _audit(
        db, "victim_assigned", admin.id, admin.role, request,
        resource="counsellor_assignments", resource_id=assignment.id,
    )

    return {
        "success": True,
        "assignment": {
            "id": assignment.id,
            "counsellor_user_id": assignment.counsellor_user_id,
            "victim_aura_id": assignment.victim_aura_id,
            "active": assignment.active,
        },
    }


@router.get("/admin/assignments")
async def admin_list_assignments(
    db: Session = Depends(get_db), admin: User = Depends(require_role("admin"))
):
    rows = db.query(CounsellorAssignment).order_by(CounsellorAssignment.created_at.desc()).all()
    return {
        "success": True,
        "assignments": [
            {
                "id": r.id,
                "counsellor_user_id": r.counsellor_user_id,
                "victim_aura_id": r.victim_aura_id,
                "active": r.active,
                "assigned_at": r.created_at.isoformat(),
            }
            for r in rows
        ],
    }


@router.delete("/admin/assignments/{assignment_id}")
async def admin_revoke_assignment(
    assignment_id: str,
    request: Request,
    db: Session = Depends(get_db),
    admin: User = Depends(require_role("admin")),
):
    assignment = db.query(CounsellorAssignment).filter(CounsellorAssignment.id == assignment_id).first()
    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found.")
    assignment.active = False
    db.commit()
    _audit(db, "victim_unassigned", admin.id, admin.role, request, resource="counsellor_assignments", resource_id=assignment.id)
    return {"success": True}


@router.get("/my-victims")
async def my_victims(
    db: Session = Depends(get_db), user: User = Depends(require_role("counsellor")),
):
    """Real, JWT-authenticated victim list for the calling counsellor - the
    aura_ids an admin has actually assigned to them. An admin calling this
    sees every active assignment across all counsellors."""
    query = db.query(CounsellorAssignment).filter(CounsellorAssignment.active.is_(True))
    if user.role == "counsellor":
        query = query.filter(CounsellorAssignment.counsellor_user_id == user.id)
    rows = query.all()
    return {
        "success": True,
        "aura_ids": [r.victim_aura_id for r in rows],
    }


# --- Guardian links -----------------------------------------------------
#
# Same admin-provisioned relationship pattern as counsellor assignments, but
# a guardian's access is a strictly smaller slice of data (no raw
# transcripts/facial data) - enforced where that data is actually served,
# not by this table alone.


class GuardianLinkRequest(BaseModel):
    guardian_user_id: str
    victim_aura_id: str


@router.post("/admin/guardian-links", status_code=status.HTTP_201_CREATED)
async def admin_create_guardian_link(
    payload: GuardianLinkRequest,
    request: Request,
    db: Session = Depends(get_db),
    admin: User = Depends(require_role("admin")),
):
    guardian = db.query(User).filter(User.id == payload.guardian_user_id).first()
    if not guardian or guardian.role != "guardian":
        raise HTTPException(status_code=422, detail="guardian_user_id must belong to a guardian account.")

    existing = (
        db.query(GuardianVictimLink)
        .filter(
            GuardianVictimLink.guardian_user_id == payload.guardian_user_id,
            GuardianVictimLink.victim_aura_id == payload.victim_aura_id,
        )
        .first()
    )
    if existing:
        existing.active = True
        db.commit()
        link = existing
    else:
        link = GuardianVictimLink(
            guardian_user_id=payload.guardian_user_id,
            victim_aura_id=payload.victim_aura_id,
            assigned_by_user_id=admin.id,
        )
        db.add(link)
        db.commit()

    _audit(db, "guardian_linked", admin.id, admin.role, request, resource="guardian_victim_links", resource_id=link.id)

    return {
        "success": True,
        "link": {
            "id": link.id,
            "guardian_user_id": link.guardian_user_id,
            "victim_aura_id": link.victim_aura_id,
            "active": link.active,
        },
    }


@router.get("/admin/guardian-links")
async def admin_list_guardian_links(
    db: Session = Depends(get_db), admin: User = Depends(require_role("admin"))
):
    rows = db.query(GuardianVictimLink).order_by(GuardianVictimLink.created_at.desc()).all()
    return {
        "success": True,
        "links": [
            {
                "id": r.id,
                "guardian_user_id": r.guardian_user_id,
                "victim_aura_id": r.victim_aura_id,
                "active": r.active,
                "assigned_at": r.created_at.isoformat(),
            }
            for r in rows
        ],
    }


@router.delete("/admin/guardian-links/{link_id}")
async def admin_revoke_guardian_link(
    link_id: str,
    request: Request,
    db: Session = Depends(get_db),
    admin: User = Depends(require_role("admin")),
):
    link = db.query(GuardianVictimLink).filter(GuardianVictimLink.id == link_id).first()
    if not link:
        raise HTTPException(status_code=404, detail="Guardian link not found.")
    link.active = False
    db.commit()
    _audit(db, "guardian_unlinked", admin.id, admin.role, request, resource="guardian_victim_links", resource_id=link.id)
    return {"success": True}


@router.get("/my-linked-victims")
async def my_linked_victims(
    db: Session = Depends(get_db), user: User = Depends(require_exact_role("guardian")),
):
    """Real, JWT-authenticated victim list for the calling guardian - the
    aura_ids an admin has actually linked them to."""
    rows = (
        db.query(GuardianVictimLink)
        .filter(GuardianVictimLink.guardian_user_id == user.id, GuardianVictimLink.active.is_(True))
        .all()
    )
    return {"success": True, "aura_ids": [r.victim_aura_id for r in rows]}
