"""Password hashing, token issuance and role-based access control.

PASSWORD HASHING uses Argon2id - the current password-hashing competition
winner and OWASP's first recommendation. Not SHA/MD5 (unsuitable, fast by
design), and not bcrypt (fine, but with a 72-byte truncation footgun).

TOKENS are JWTs signed with HS256. The database stores only a SHA-256 hash of
each token, so a database read cannot be replayed as a live session, and
logout works by revoking the stored row rather than hoping the client forgets.

ACCOUNT LOCKOUT throttles credential stuffing: repeated failures lock the
account for a cooldown window. Login always reports the same generic message
whether the email exists or not, so the endpoint is not a user enumerator.
"""
import hashlib
import hmac
import logging
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from fastapi import Cookie, Depends, Header, HTTPException, Request, Response, status
from sqlalchemy.orm import Session

from ..core.config import settings
from ..database import get_db
from ..database.models import AuthSession, User

logger = logging.getLogger("aura.auth")

_hasher = PasswordHasher()

ROLES = ("victim", "counsellor", "admin", "guardian")

# Role hierarchy for permission checks. An admin satisfies a counsellor
# requirement; a victim never satisfies either. guardian is a lateral,
# relationship-scoped role (sees only their linked victim, via
# GuardianVictimLink) rather than a rung on the clinical-access ladder, so it
# shares victim's rank here - require_role() would otherwise let a guardian
# pass a "counsellor" check, which is wrong. Endpoints that must admit
# guardians specifically use require_exact_role(), not require_role().
ROLE_RANK = {"victim": 1, "counsellor": 2, "admin": 3, "guardian": 1}

GENERIC_LOGIN_ERROR = "Incorrect email or password."


# --- Passwords -------------------------------------------------------------


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        _hasher.verify(password_hash, password)
        return True
    except (VerifyMismatchError, InvalidHashError):
        return False
    except Exception:  # noqa: BLE001 - never leak hashing internals to callers
        logger.exception("Password verification error")
        return False


def password_problems(password: str) -> list[str]:
    """Validation messages for a candidate password, or [] if acceptable."""
    problems = []
    if len(password) < 12:
        problems.append("Password must be at least 12 characters.")
    if password.isdigit() or password.isalpha():
        problems.append("Password must mix letters with numbers or symbols.")
    if password.lower() in {"password123", "aurapassword", "changeme123"}:
        problems.append("Password is too common.")
    return problems


# --- Pseudonymous identity -------------------------------------------------


def generate_aura_id() -> str:
    """A pseudonymous identifier with no relationship to the user's identity.

    Derived from random bytes, NOT from the email or name - a derived id would
    be reversible by dictionary attack and would defeat the whole point of
    separating identity from analysis data.
    """
    return f"AURA-{uuid.uuid4().hex[:12].upper()}"


# --- Tokens ----------------------------------------------------------------


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_access_token(user: User, db: Session, user_agent: Optional[str] = None) -> dict:
    """Issues a JWT and records its hash as an active session."""
    now = datetime.now(timezone.utc)
    expires = now + timedelta(minutes=settings.access_token_minutes)

    payload = {
        "sub": user.id,
        # aura_id travels in the token so downstream services can scope data
        # without a second lookup into the identity table.
        "aura_id": user.aura_id,
        "role": user.role,
        "iat": int(now.timestamp()),
        "exp": int(expires.timestamp()),
        "jti": str(uuid.uuid4()),
    }
    token = jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)

    db.add(
        AuthSession(
            user_id=user.id,
            token_hash=_token_hash(token),
            expires_at=expires,
            user_agent=(user_agent or "")[:255] or None,
        )
    )
    db.commit()

    return {
        "access_token": token,
        "token_type": "bearer",
        "expires_at": expires.isoformat(),
        "role": user.role,
        "aura_id": user.aura_id,
    }


def revoke_token(token: str, db: Session) -> bool:
    session_row = (
        db.query(AuthSession).filter(AuthSession.token_hash == _token_hash(token)).first()
    )
    if not session_row or session_row.revoked_at is not None:
        return False
    session_row.revoked_at = datetime.now(timezone.utc)
    db.commit()
    return True


def decode_token(token: str) -> Optional[dict]:
    try:
        return jwt.decode(
            token, settings.jwt_secret, algorithms=[settings.jwt_algorithm]
        )
    except jwt.PyJWTError:
        return None


# --- Lockout ---------------------------------------------------------------


def is_locked(user: User) -> bool:
    if user.locked_until is None:
        return False
    locked_until = user.locked_until
    if locked_until.tzinfo is None:
        locked_until = locked_until.replace(tzinfo=timezone.utc)
    return locked_until > datetime.now(timezone.utc)


def register_failed_login(user: User, db: Session) -> None:
    user.failed_login_count += 1
    if user.failed_login_count >= settings.max_failed_logins:
        user.locked_until = datetime.now(timezone.utc) + timedelta(
            minutes=settings.lockout_minutes
        )
        user.failed_login_count = 0
        logger.warning("Account locked after repeated failed logins: %s", user.aura_id)
    db.commit()


def clear_failed_logins(user: User, db: Session) -> None:
    user.failed_login_count = 0
    user.locked_until = None
    user.last_login_at = datetime.now(timezone.utc)
    db.commit()


# --- Dependencies ----------------------------------------------------------


def _extract_bearer(authorization: Optional[str]) -> Optional[str]:
    if not authorization:
        return None
    parts = authorization.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return parts[1].strip()


def get_current_user(
    authorization: Optional[str] = Header(default=None),
    db: Session = Depends(get_db),
    aura_session: Optional[str] = Cookie(default=None),
) -> User:
    """Resolves the authenticated user, or raises 401.

    Accepts EITHER an `Authorization: Bearer <token>` header (the original
    mechanism, kept for existing callers) OR the httpOnly session cookie
    Google/OTP logins set - same JWT, same validity rules, just two ways for
    the browser to carry it. The header takes precedence when both are
    present.

    Checks BOTH that the JWT is valid and that its stored session row is still
    active. A signed-but-revoked token is rejected, which is what makes logout
    actually mean something.
    """
    token = _extract_bearer(authorization) or aura_session
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    payload = decode_token(token)
    if not payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token."
        )

    session_row = (
        db.query(AuthSession).filter(AuthSession.token_hash == _token_hash(token)).first()
    )
    if session_row is None or session_row.revoked_at is not None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Session is no longer valid."
        )

    user = db.query(User).filter(User.id == payload.get("sub")).first()
    if user is None or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Account is not active."
        )
    return user


def require_role(*allowed: str):
    """Dependency factory enforcing a minimum role.

    Uses the rank hierarchy, so `require_role("counsellor")` also admits an
    admin without every route having to list both.
    """
    minimum = min(ROLE_RANK[r] for r in allowed)

    def _check(user: User = Depends(get_current_user)) -> User:
        if ROLE_RANK.get(user.role, 0) < minimum:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Your role does not have access to this resource.",
            )
        return user

    return _check


def require_exact_role(*allowed: str):
    """Dependency factory for LATERAL roles (currently just 'guardian') that
    require_role()'s rank hierarchy cannot express correctly - membership is
    exact-match, not "at least this rank"."""

    def _check(user: User = Depends(get_current_user)) -> User:
        if user.role not in allowed:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Your role does not have access to this resource.",
            )
        return user

    return _check


# --- Session cookie (Google OAuth / OTP logins) -----------------------------
#
# Bearer-token callers are unaffected by any of this - it's an ADDITIONAL,
# more defensible transport for the newer login methods, not a replacement.


def set_session_cookies(response: Response, token: str, expires_at: datetime) -> None:
    """Sets the httpOnly session cookie plus a separate, JS-readable CSRF
    cookie (double-submit pattern - see verify_csrf below). `secure=True`
    only when AURA_ENV=production, since a plain http://localhost dev server
    cannot set a Secure cookie the browser will actually store."""
    max_age = max(0, int((expires_at - datetime.now(timezone.utc)).total_seconds()))
    response.set_cookie(
        key=settings.session_cookie_name,
        value=token,
        max_age=max_age,
        httponly=True,
        secure=settings.is_production,
        samesite="lax",
        path="/",
    )
    response.set_cookie(
        key=settings.csrf_cookie_name,
        value=secrets.token_urlsafe(32),
        max_age=max_age,
        httponly=False,  # the frontend must be able to read this one
        secure=settings.is_production,
        samesite="lax",
        path="/",
    )


def clear_session_cookies(response: Response) -> None:
    response.delete_cookie(settings.session_cookie_name, path="/")
    response.delete_cookie(settings.csrf_cookie_name, path="/")


def verify_csrf(
    request: Request,
    authorization: Optional[str] = Header(default=None),
    aura_csrf: Optional[str] = Cookie(default=None),
    x_csrf_token: Optional[str] = Header(default=None),
) -> None:
    """Double-submit CSRF check for cookie-authenticated mutating requests.

    A request authenticated via the Authorization header is exempt: unlike a
    cookie, a browser never attaches that header automatically to a
    cross-site request, so the classic CSRF vector doesn't apply to it.
    A cookie-authenticated request must echo the CSRF cookie's value back in
    the X-CSRF-Token header - a cross-site page can trigger the cookie to be
    sent, but cannot read it to put in a header (same-origin policy).
    """
    if _extract_bearer(authorization):
        return
    if not aura_csrf or not x_csrf_token or not hmac.compare_digest(aura_csrf, x_csrf_token):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="CSRF check failed.")


def require_self_or_role(target_aura_id: str, user: User, *allowed: str) -> None:
    """Authorises access to another person's data.

    A user may always read their own records. Anyone else needs an elevated
    role. This is the check that stops one victim reading another's data.
    """
    if user.aura_id == target_aura_id:
        return
    minimum = min(ROLE_RANK[r] for r in allowed)
    if ROLE_RANK.get(user.role, 0) < minimum:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You may only access your own records.",
        )
