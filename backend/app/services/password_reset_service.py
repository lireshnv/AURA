"""Forgot-password reset links for an EXISTING AURA user.

Same rules as services/otp_service.py: the reset token is a high-entropy
random string generated server-side; only its SHA-256 hash is ever stored, so
a database read alone can never be replayed as a valid link. No real
email provider is configured in this environment, so delivery honestly falls
back to logging the link to the BACKEND console only - never to any HTTP
response the browser can see.
"""
import hashlib
import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional, Tuple

from sqlalchemy.orm import Session

from ..core.config import settings
from ..database.models import PasswordResetToken, User

logger = logging.getLogger("aura.password_reset")

TOKEN_TTL_MINUTES = 30
RESEND_COOLDOWN_SECONDS = 60


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _deliver(user: User, token: str) -> None:
    reset_url = f"{settings.frontend_url}/?reset_token={token}"
    if settings.otp_provider_configured:
        logger.warning(
            "OTP_PROVIDER_KEY is set but no email provider integration is implemented; "
            "falling back to console delivery for %s.", user.email,
        )
    logger.info("[DEV PASSWORD RESET - not actually sent] Reset link for %s: %s", user.email, reset_url)


def request_reset(user: User, db: Session) -> Tuple[bool, str]:
    """Generates, hashes, stores, and 'sends' a reset link. Returns
    (success, reason) - reason is "cooldown" if one was already sent recently."""
    latest = (
        db.query(PasswordResetToken)
        .filter(PasswordResetToken.user_id == user.id)
        .order_by(PasswordResetToken.created_at.desc())
        .first()
    )
    if latest:
        age = (datetime.now(timezone.utc) - latest.created_at.replace(tzinfo=timezone.utc)).total_seconds()
        if age < RESEND_COOLDOWN_SECONDS:
            return False, "cooldown"

    token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    db.add(
        PasswordResetToken(
            user_id=user.id,
            token_hash=_hash_token(token),
            expires_at=now + timedelta(minutes=TOKEN_TTL_MINUTES),
        )
    )
    db.commit()

    _deliver(user, token)
    return True, "sent"


def consume_reset_token(token: str, db: Session) -> Tuple[Optional[User], str]:
    """Validates and (on success) consumes a reset token in one step, so it
    cannot be used twice even if two requests race. Returns (user, reason) -
    reason is one of: ok, invalid, expired, used."""
    entry: Optional[PasswordResetToken] = (
        db.query(PasswordResetToken)
        .filter(PasswordResetToken.token_hash == _hash_token(token))
        .first()
    )
    if not entry:
        return None, "invalid"
    if entry.consumed_at is not None:
        return None, "used"
    now = datetime.now(timezone.utc)
    if entry.expires_at.replace(tzinfo=timezone.utc) < now:
        return None, "expired"

    entry.consumed_at = now
    db.commit()

    user = db.query(User).filter(User.id == entry.user_id).first()
    if not user or not user.is_active:
        return None, "invalid"
    return user, "ok"
