"""SOS trigger API - a dedicated, real emergency-signal path separate from
normal navigation and from the AI Companion's in-conversation crisis
detection (`chat_safety.py`). This is the user directly pressing the SOS
button, not the model inferring anything.

No fake contacts, locations, or demo events: location is only ever the
coordinates the browser's Geolocation API actually returned for this click
(optional - a decline or unsupported browser just omits it), and every event
returned to the caller was actually written to the store.
"""
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import sos_store
from ..database import get_db
from ..database.models import User
from ..security.auth import get_current_user
from ..security.authz import can_access_victim
from .chat import resolve_aura_id

logger = logging.getLogger("aura.sos_api")
router = APIRouter(prefix="/api/sos", tags=["sos"])


class SosTriggerRequest(BaseModel):
    latitude: Optional[float] = Field(default=None, ge=-90, le=90)
    longitude: Optional[float] = Field(default=None, ge=-180, le=180)
    page: Optional[str] = Field(default=None, max_length=64)


@router.post("/trigger")
async def trigger_sos(payload: SosTriggerRequest, aura_id: str = Depends(resolve_aura_id)):
    event = sos_store.record_event(
        aura_id, latitude=payload.latitude, longitude=payload.longitude, page=payload.page
    )
    if not event:
        return {"success": False, "error": "Could not record the SOS event. Please try again."}
    return {"success": True, **event}


@router.get("/history")
async def sos_history(aura_id: str = Depends(resolve_aura_id)):
    return {"success": True, "events": sos_store.list_events(aura_id)}


@router.get("/history/{victim_aura_id}")
async def sos_history_for(
    victim_aura_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """SOS status for one victim, visible only to that victim, their
    assigned counsellor(s), their linked guardian(s), or an admin - "SOS
    status where authorised", per the same rule used for call history and
    the guardian summary."""
    if not can_access_victim(user, victim_aura_id, db):
        raise HTTPException(status_code=403, detail="You are not authorised for this victim.")
    return {"success": True, "events": sos_store.list_events(victim_aura_id)}
