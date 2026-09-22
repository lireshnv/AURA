"""Google OAuth 2.0 ("Continue with Google"), server-side only.

The browser only ever sees a redirect URL - it never receives, stores, or
could read GOOGLE_CLIENT_SECRET. The authorization code exchange and ID
token verification both happen here, in the backend, using the Google
account's own cryptographic signature (not a value the frontend could forge).

CSRF/replay protection: `state` is a random, single-use, server-tracked
value bound to the request that started the flow - a callback with an
unknown or reused state is rejected outright. PKCE (S256) additionally
binds the authorization code to the exact client that requested it, so an
intercepted code alone is not enough to complete the exchange.
"""
import base64
import hashlib
import logging
import secrets
import threading
import time
from typing import Dict, Optional, Tuple
from urllib.parse import urlencode

import requests
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token

from ..core.config import settings

logger = logging.getLogger("aura.google_oauth")

AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
STATE_TTL_SECONDS = 600

_lock = threading.Lock()
# state -> {code_verifier, created_at}. In-memory, single-process - matches
# every other realtime/ephemeral store in this codebase (chat history, IVRS
# call sockets); a multi-instance deployment would need a shared store.
_pending: Dict[str, Dict] = {}


def is_configured() -> bool:
    return settings.google_oauth_configured


def _cleanup_expired() -> None:
    now = time.time()
    expired = [s for s, v in _pending.items() if now - v["created_at"] > STATE_TTL_SECONDS]
    for s in expired:
        _pending.pop(s, None)


def build_authorization_url() -> str:
    """Generates a fresh state + PKCE pair, remembers the verifier
    server-side keyed by state, and returns the URL to redirect the browser
    to. Raises RuntimeError if Google OAuth isn't configured."""
    if not is_configured():
        raise RuntimeError("google_oauth_not_configured")

    state = secrets.token_urlsafe(32)
    code_verifier = secrets.token_urlsafe(64)[:128]
    challenge_digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    code_challenge = base64.urlsafe_b64encode(challenge_digest).rstrip(b"=").decode("ascii")

    with _lock:
        _cleanup_expired()
        _pending[state] = {"code_verifier": code_verifier, "created_at": time.time()}

    params = {
        "client_id": settings.google_client_id,
        "redirect_uri": settings.google_redirect_uri,
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
        "access_type": "online",
        "prompt": "select_account",
    }
    return f"{AUTH_ENDPOINT}?{urlencode(params)}"


def consume_state(state: str) -> Optional[str]:
    """Validates and single-use-consumes a state value, returning its PKCE
    code_verifier, or None if the state is unknown, reused, or expired."""
    with _lock:
        entry = _pending.pop(state, None)
    if not entry:
        return None
    if time.time() - entry["created_at"] > STATE_TTL_SECONDS:
        return None
    return entry["code_verifier"]


def exchange_code(code: str, code_verifier: str) -> Tuple[Optional[Dict], Optional[str]]:
    """Trades the authorization code for tokens. Returns (claims, error) -
    claims come from verifying the ID token's signature against Google's own
    published keys, so they cannot be forged by anyone who doesn't control
    the Google account itself."""
    try:
        response = requests.post(
            TOKEN_ENDPOINT,
            data={
                "code": code,
                "client_id": settings.google_client_id,
                "client_secret": settings.google_client_secret,
                "redirect_uri": settings.google_redirect_uri,
                "grant_type": "authorization_code",
                "code_verifier": code_verifier,
            },
            timeout=15,
        )
    except requests.RequestException as exc:
        logger.warning("Google token exchange request failed: %s", exc)
        return None, "token_request_failed"

    if response.status_code != 200:
        logger.warning("Google token exchange returned %s: %s", response.status_code, response.text[:300])
        return None, "token_exchange_failed"

    id_token_str = response.json().get("id_token")
    if not id_token_str:
        return None, "no_id_token"

    try:
        claims = google_id_token.verify_oauth2_token(
            id_token_str, google_requests.Request(), audience=settings.google_client_id
        )
    except ValueError as exc:
        logger.warning("Google ID token verification failed: %s", exc)
        return None, "invalid_id_token"

    if not claims.get("email_verified", False):
        return None, "email_not_verified"

    return claims, None
