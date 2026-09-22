"""My Safety Plan + Trusted Contacts.

Real per-user data from day one (unlike twin_store.py's single-shared
prototype store) - every row is scoped by the authenticated user's aura_id,
via the same `get_current_user` dependency auth_routes.py uses.

Nothing here is ever auto-shared, auto-dialled or auto-notified. AURA only
ever displays back to the user what the user themselves entered - the same
posture already established by sos.py and chat_safety.py.
"""
import logging
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..database import get_db
from ..database.models import SafetyPlan, TrustedContact, User
from ..security.auth import get_current_user

logger = logging.getLogger("aura.safety_plan")
router = APIRouter(prefix="/api/safety-plan", tags=["safety-plan"])


# --- Schemas -----------------------------------------------------------------


class TrustedContactIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    relationship_label: Optional[str] = Field(default=None, max_length=60)
    phone: Optional[str] = Field(default=None, max_length=32)
    email: Optional[str] = Field(default=None, max_length=320)
    notes: Optional[str] = None


class SafetyPlanIn(BaseModel):
    warning_signs: List[str] = Field(default_factory=list)
    coping_things: List[str] = Field(default_factory=list)
    contact_ids: List[str] = Field(default_factory=list)
    professional_contact: Optional[str] = None


def _contact_out(c: TrustedContact) -> dict:
    return {
        "id": c.id,
        "name": c.name,
        "relationship_label": c.relationship_label,
        "phone": c.phone,
        "email": c.email,
        "notes": c.notes,
    }


def _plan_out(plan: Optional[SafetyPlan]) -> dict:
    if plan is None:
        return {
            "exists": False,
            "warning_signs": [],
            "coping_things": [],
            "contact_ids": [],
            "professional_contact": None,
        }
    return {
        "exists": True,
        "warning_signs": plan.warning_signs or [],
        "coping_things": plan.coping_things or [],
        "contact_ids": plan.contact_ids or [],
        "professional_contact": plan.professional_contact,
        "updated_at": plan.updated_at.isoformat() if plan.updated_at else None,
    }


# --- Trusted contacts ---------------------------------------------------------


@router.get("/contacts")
async def list_contacts(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    contacts = (
        db.query(TrustedContact)
        .filter(TrustedContact.aura_id == user.aura_id)
        .order_by(TrustedContact.created_at.asc())
        .all()
    )
    return {"success": True, "contacts": [_contact_out(c) for c in contacts]}


@router.post("/contacts")
async def add_contact(
    payload: TrustedContactIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    contact = TrustedContact(aura_id=user.aura_id, **payload.model_dump())
    db.add(contact)
    db.commit()
    db.refresh(contact)
    return {"success": True, "contact": _contact_out(contact)}


@router.put("/contacts/{contact_id}")
async def update_contact(
    contact_id: str,
    payload: TrustedContactIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    contact = (
        db.query(TrustedContact)
        .filter(TrustedContact.id == contact_id, TrustedContact.aura_id == user.aura_id)
        .first()
    )
    if contact is None:
        raise HTTPException(status_code=404, detail="Contact not found.")
    for field, value in payload.model_dump().items():
        setattr(contact, field, value)
    db.commit()
    db.refresh(contact)
    return {"success": True, "contact": _contact_out(contact)}


@router.delete("/contacts/{contact_id}")
async def delete_contact(
    contact_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    contact = (
        db.query(TrustedContact)
        .filter(TrustedContact.id == contact_id, TrustedContact.aura_id == user.aura_id)
        .first()
    )
    if contact is None:
        raise HTTPException(status_code=404, detail="Contact not found.")
    db.delete(contact)
    # A deleted contact must not linger as a dangling reference in the plan.
    plan = db.query(SafetyPlan).filter(SafetyPlan.aura_id == user.aura_id).first()
    if plan and contact_id in (plan.contact_ids or []):
        plan.contact_ids = [c for c in plan.contact_ids if c != contact_id]
    db.commit()
    return {"success": True, "deleted": True}


# --- Safety plan ---------------------------------------------------------------


@router.get("")
@router.get("/")
async def get_plan(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    plan = db.query(SafetyPlan).filter(SafetyPlan.aura_id == user.aura_id).first()
    return {"success": True, "plan": _plan_out(plan)}


@router.put("")
@router.put("/")
async def upsert_plan(
    payload: SafetyPlanIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # Only contacts that actually belong to this person may be referenced -
    # otherwise a crafted id could point the plan at someone else's contact.
    valid_ids = {
        c.id
        for c in db.query(TrustedContact.id)
        .filter(TrustedContact.aura_id == user.aura_id, TrustedContact.id.in_(payload.contact_ids))
        .all()
    }
    contact_ids = [cid for cid in payload.contact_ids if cid in valid_ids]

    plan = db.query(SafetyPlan).filter(SafetyPlan.aura_id == user.aura_id).first()
    if plan is None:
        plan = SafetyPlan(aura_id=user.aura_id)
        db.add(plan)

    plan.warning_signs = payload.warning_signs
    plan.coping_things = payload.coping_things
    plan.contact_ids = contact_ids
    plan.professional_contact = payload.professional_contact
    plan.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(plan)
    return {"success": True, "plan": _plan_out(plan)}
