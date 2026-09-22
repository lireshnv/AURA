"""API for Risk & Trend, human review and the audit log."""
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from . import audit_store, risk_service
from .database.models import User
from .security.auth import require_role

router = APIRouter(prefix="/api/risk", tags=["risk"])


class ReviewRequest(BaseModel):
    """A user asking for support, or a counsellor recording a review action."""

    aura_id: str = "local-user"
    action: str
    actor_role: str
    actor_id: Optional[str] = None
    reason: Optional[str] = None


@router.get("/assessment")
async def assessment():
    """Current Risk & Trend for the consented user, from real data only."""
    return risk_service.assess_current_risk()


@router.get("/history")
async def history(days: int = 7):
    """Distress signal over recent days. Days without data produce no point."""
    return {"success": True, **risk_service.distress_history(days)}


@router.post("/review")
async def record_review(payload: ReviewRequest):
    """Records a HUMAN action. Every call is written to the audit log.

    This endpoint never changes a risk score and never triggers an external
    notification - it records that a person did something.
    """
    if payload.action not in audit_store.ACTIONS:
        return {
            "success": False,
            "error": f"Unknown action. Allowed: {', '.join(audit_store.ACTIONS)}",
        }
    if not payload.actor_role.strip():
        return {"success": False, "error": "An action must record who performed it."}

    entry_id = audit_store.record(
        aura_id=payload.aura_id,
        action=payload.action,
        actor_role=payload.actor_role,
        actor_id=payload.actor_id,
        reason=payload.reason,
    )
    return {
        "success": entry_id is not None,
        "id": entry_id,
        "review_status": audit_store.review_status(payload.aura_id),
        "note": "Recorded. No external party has been contacted.",
    }


@router.get("/review/status")
async def review_status(aura_id: str = "local-user"):
    return {"success": True, "aura_id": aura_id, **audit_store.review_status(aura_id)}


@router.get("/audit")
async def audit_log(
    aura_id: Optional[str] = None,
    limit: int = 100,
    user: User = Depends(require_role("counsellor")),
):
    """Audit trail. Restricted to authorised roles via real JWT-based
    authorization (the previous client-supplied X-Aura-Role header was
    spoofable and is no longer trusted).

    Entries carry pseudonymous IDs, an action, a role and a reason - never
    names, contact details or signal values.
    """
    return {
        "success": True,
        "entries": audit_store.list_entries(aura_id, limit),
        "note": "Append-only. Entries cannot be edited or deleted.",
    }
