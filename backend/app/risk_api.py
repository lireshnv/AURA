"""API for Risk & Trend, human review and the audit log."""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from . import audit_store, risk_service
from .database import get_db
from .database.models import User
from .security.auth import get_current_user, require_role
from .security.authz import can_access_victim, resolve_subject_aura_id
from sqlalchemy.orm import Session

router = APIRouter(prefix="/api/risk", tags=["risk"])


class ReviewRequest(BaseModel):
    """A user asking for support, or a counsellor recording a review action."""

    aura_id: str = "local-user"
    action: str
    actor_role: str
    actor_id: Optional[str] = None
    reason: Optional[str] = None


@router.get("/assessment")
async def assessment(
    aura_id: Optional[str] = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Current Risk & Trend, from real data only. A victim always gets their
    own; other roles pass `aura_id` for a case they're authorized on."""
    subject = resolve_subject_aura_id(user, aura_id, db)
    return risk_service.assess_current_risk(aura_id=subject)


@router.get("/history")
async def history(
    days: int = 7,
    aura_id: Optional[str] = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Distress signal over recent days. Days without data produce no point."""
    subject = resolve_subject_aura_id(user, aura_id, db)
    return {"success": True, **risk_service.distress_history(days, aura_id=subject)}


@router.post("/review")
async def record_review(
    payload: ReviewRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Records a HUMAN action. Every call is written to the audit log.

    This endpoint never changes a risk score and never triggers an external
    notification - it records that a person did something.

    actor_role/actor_id come from the AUTHENTICATED user, not the request
    body - this previously had no auth at all and trusted whatever
    actor_role the client claimed, which meant any caller could forge an
    audit entry attributed to "counsellor" or "admin".

    Role check is manual rather than require_role() because it isn't a
    simple rank cutoff: counsellor/admin may record any action, but a
    guardian may ONLY request a follow-up (flagging a concern to the
    assigned counsellor, real coordination the spec asks for) - never
    risk_reviewed/continue_monitoring, which imply clinical review
    authority a guardian doesn't have. require_role()'s rank hierarchy
    can't express "this rank, but only for one specific action" - and
    ROLE_RANK puts guardian at the same rank as victim, so a plain rank
    cutoff would have to admit victims too.
    """
    if user.role not in ("counsellor", "admin", "guardian"):
        raise HTTPException(status_code=403, detail="Your role does not have access to this resource.")
    if user.role == "guardian" and payload.action != "review_requested":
        raise HTTPException(
            status_code=403,
            detail="A guardian may only request a follow-up review, not record a clinical decision.",
        )
    if not can_access_victim(user, payload.aura_id, db):
        raise HTTPException(status_code=403, detail="Not authorised for this case.")
    if payload.action not in audit_store.ACTIONS:
        return {
            "success": False,
            "error": f"Unknown action. Allowed: {', '.join(audit_store.ACTIONS)}",
        }

    entry_id = audit_store.record(
        aura_id=payload.aura_id,
        action=payload.action,
        actor_role=user.role,
        actor_id=user.id,
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
