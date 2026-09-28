"""Application configuration, loaded from the environment.

NOTHING SECRET IS HARD-CODED. Every credential is read from an environment
variable, and `.env.example` documents them without containing real values.

Startup behaviour on a missing JWT secret is deliberate:

  * In development, a random secret is generated per process. Tokens then stop
    working across restarts - which is mildly annoying, and far better than a
    predictable default that silently becomes the production key.
  * When AURA_ENV=production, a missing or weak secret raises at import. The
    app refuses to start rather than run insecurely.
"""
import os
import secrets
import logging
from functools import lru_cache

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # python-dotenv optional
    pass

logger = logging.getLogger("aura.config")

ENV = os.environ.get("AURA_ENV", "development").lower()
IS_PRODUCTION = ENV == "production"

MIN_SECRET_LENGTH = 32


def _load_secret() -> str:
    secret = os.environ.get("AURA_JWT_SECRET", "").strip()
    if secret and len(secret) >= MIN_SECRET_LENGTH:
        return secret

    if IS_PRODUCTION:
        raise RuntimeError(
            "AURA_JWT_SECRET must be set to at least "
            f"{MIN_SECRET_LENGTH} characters when AURA_ENV=production. "
            "Refusing to start with a weak or generated signing key."
        )

    logger.warning(
        "AURA_JWT_SECRET not set - generating an ephemeral development key. "
        "Sessions will not survive a restart. Never do this in production."
    )
    return secrets.token_urlsafe(48)


class Settings:
    """Runtime settings. Values are read once at import."""

    env: str = ENV
    is_production: bool = IS_PRODUCTION

    # --- Auth ---
    jwt_secret: str = _load_secret()
    jwt_algorithm: str = os.environ.get("AURA_JWT_ALGORITHM", "HS256")
    access_token_minutes: int = int(os.environ.get("AURA_ACCESS_TOKEN_MINUTES", "60"))
    max_failed_logins: int = int(os.environ.get("AURA_MAX_FAILED_LOGINS", "5"))
    lockout_minutes: int = int(os.environ.get("AURA_LOCKOUT_MINUTES", "15"))

    # --- CORS. Restricted by default; never "*" in production. ---
    cors_origins: list[str] = [
        o.strip()
        for o in os.environ.get(
            "AURA_CORS_ORIGINS",
            "http://localhost:6969,http://127.0.0.1:6969,"
            "http://localhost:5173,http://127.0.0.1:5173",
        ).split(",")
        if o.strip()
    ]
    # Optional regex for origins that can't be listed up front, e.g. Netlify's
    # per-deploy URLs (https://<deploy-id>--<site>.netlify.app). Unset = off.
    cors_origin_regex: str | None = os.environ.get("AURA_CORS_ORIGIN_REGEX") or None

    # --- Rate limiting ---
    rate_limit_enabled: bool = os.environ.get("AURA_RATE_LIMIT", "1") != "0"
    auth_rate_limit: str = os.environ.get("AURA_AUTH_RATE_LIMIT", "10/minute")
    api_rate_limit: str = os.environ.get("AURA_API_RATE_LIMIT", "120/minute")

    # --- Database ---
    database_url: str = os.environ.get("DATABASE_URL", "")

    # --- Session cookie (Google OAuth / OTP logins issue this in addition to
    #     the bearer token, so existing bearer-based callers keep working
    #     unchanged while new logins get the more defensible cookie). Falls
    #     back to jwt_secret in dev so a fresh checkout works with zero setup;
    #     production should set a real distinct value. ---
    session_secret: str = os.environ.get("SESSION_SECRET", "").strip() or jwt_secret
    session_cookie_name: str = "aura_session"
    csrf_cookie_name: str = "aura_csrf"

    # --- Google OAuth 2.0 ("Continue with Google") ---
    google_client_id: str = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
    google_client_secret: str = os.environ.get("GOOGLE_CLIENT_SECRET", "").strip()
    google_redirect_uri: str = os.environ.get(
        "GOOGLE_REDIRECT_URI", "http://127.0.0.1:6970/api/auth/google/callback"
    )
    frontend_url: str = os.environ.get("AURA_FRONTEND_URL", "http://localhost:6969")

    @property
    def google_oauth_configured(self) -> bool:
        return bool(self.google_client_id and self.google_client_secret)

    # --- OTP login. No real provider configured by default - see
    #     services/otp_service.py for the honest console-only dev fallback. ---
    otp_provider_key: str = os.environ.get("OTP_PROVIDER_KEY", "").strip()
    otp_ttl_minutes: int = int(os.environ.get("OTP_TTL_MINUTES", "5"))
    otp_max_attempts: int = int(os.environ.get("OTP_MAX_ATTEMPTS", "5"))
    otp_resend_cooldown_seconds: int = int(os.environ.get("OTP_RESEND_COOLDOWN_SECONDS", "60"))

    @property
    def otp_provider_configured(self) -> bool:
        return bool(self.otp_provider_key)

    # --- Optional third-party integrations. Absent by default; each service
    #     reports unavailable rather than failing when its key is missing. ---
    gemini_api_key: str = os.environ.get("GEMINI_API_KEY", "")

    @property
    def gemini_configured(self) -> bool:
        return bool(self.gemini_api_key)

    def integration_status(self) -> dict:
        """Honest report of which optional integrations are actually usable."""
        return {
            "gemini": {
                "configured": self.gemini_configured,
                "note": "Set GEMINI_API_KEY to enable LLM explanation."
                if not self.gemini_configured
                else "Configured.",
            },
            "database": {
                "configured": bool(self.database_url),
                "backend": "postgresql" if self.database_url.startswith("postgres") else "sqlite",
                "note": "Set DATABASE_URL for PostgreSQL; SQLite is used otherwise.",
            },
        }


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
