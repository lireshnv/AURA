"""OTP (one-time code) login for an EXISTING AURA user.

The OTP itself is NEVER generated, returned, or verified in frontend code -
everything below runs server-side only. Only its HMAC hash is ever stored
(same rule as passwords/session tokens elsewhere in this codebase), so a
database read alone can never be replayed as a valid code.

No real SMS/email provider is configured in this environment. Rather than
faking a "sent" response, delivery honestly falls back to logging the code
to the BACKEND console only (never to any HTTP response the browser can see)
when no provider is configured - fine for local development, and the
codebase-wide pattern for any integration without real credentials (see
chatbot_service.is_configured(), elevenlabs_tts.is_configured(), etc.).
"""
import hashlib
import hmac
import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional, Tuple

from sqlalchemy.orm import Session

from ..core.config import settings
from ..database.models import OtpCode, User

logger = logging.getLogger("aura.otp")

CODE_LENGTH = 6


def _hash_code(code: str, user_id: str) -> str:
    """HMAC keyed by the server-side session secret, salted with the user id
    so the same numeric code for two different users never hashes the same."""
    return hmac.new(
        settings.session_secret.encode("utf-8"),
        f"{user_id}:{code}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def _deliver(user: User, code: str) -> None:
    """Sends the code. Honest about not actually sending anything when no
    real provider is configured - logs to the backend's own console only."""
    if settings.otp_provider_configured:
        # A real provider integration (SMTP/SMS) would go here, keyed by
        # OTP_PROVIDER_KEY. None is wired up yet - not a call this codebase
        # can make on the user's behalf without knowing which provider.
        logger.warning(
            "OTP_PROVIDER_KEY is set but no provider integration is implemented; "
            "falling back to console delivery for %s.", user.email,
        )
    logger.info("[DEV OTP - not actually sent] Login code for %s: %s", user.email, code)


def request_otp(user: User, db: Session) -> Tuple[bool, str]:
    """Generates, hashes, stores, and 'sends' a login code. Returns
    (success, reason) - reason is "cooldown" if a code was already sent too
    recently (rate limits sending, not just verifying)."""
    latest = (
        db.query(OtpCode)
        .filter(OtpCode.user_id == user.id, OtpCode.purpose == "login")
        .order_by(OtpCode.created_at.desc())
        .first()
    )
    if latest:
        age = (datetime.now(timezone.utc) - latest.created_at.replace(tzinfo=timezone.utc)).total_seconds()
        if age < settings.otp_resend_cooldown_seconds:
            return False, "cooldown"

    code = "".join(secrets.choice("0123456789") for _ in range(CODE_LENGTH))
    now = datetime.now(timezone.utc)
    db.add(
        OtpCode(
            user_id=user.id,
            code_hash=_hash_code(code, user.id),
            purpose="login",
            expires_at=now + timedelta(minutes=settings.otp_ttl_minutes),
        )
    )
    db.commit()

    _deliver(user, code)
    return True, "sent"


def verify_otp(user: User, code: str, db: Session) -> Tuple[bool, str]:
    """Checks the most recent unconsumed code for this user. Returns
    (ok, reason) - reason is one of: ok, no_code, expired, too_many_attempts,
    invalid_code."""
    entry: Optional[OtpCode] = (
        db.query(OtpCode)
        .filter(OtpCode.user_id == user.id, OtpCode.purpose == "login", OtpCode.consumed_at.is_(None))
        .order_by(OtpCode.created_at.desc())
        .first()
    )
    if not entry:
        return False, "no_code"

    now = datetime.now(timezone.utc)
    if entry.expires_at.replace(tzinfo=timezone.utc) < now:
        return False, "expired"
    if entry.attempts >= settings.otp_max_attempts:
        return False, "too_many_attempts"

    if not hmac.compare_digest(entry.code_hash, _hash_code(code.strip(), user.id)):
        entry.attempts += 1
        db.commit()
        return False, "invalid_code"

    entry.consumed_at = now
    db.commit()
    return True, "ok"
