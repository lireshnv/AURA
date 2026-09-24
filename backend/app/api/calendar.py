"""The shared Aura Calendar - one events table every role's calendar view
reads from (victim/counsellor/admin/guardian), scoped by the same
can_access_victim() authorization already used for cases and documents.

Read access follows can_access_victim() (self / admin / assigned counsellor /
linked guardian). Write access is narrower: a guardian's dashboard is
read-only by design (see GuardianDashboard.tsx), so creating, editing or
deleting an event is restricted to the victim themselves, a counsellor, or
an admin - never a guardian.
"""
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..database import get_db
from ..database.models import AuditLog, CalendarEvent, User
from ..security.auth import get_current_user
from ..security.authz import authorized_victim_ids, can_access_victim

router = APIRouter(prefix="/api/calendar", tags=["calendar"])

EVENT_TYPES = [
    {"value": "hearing", "label": "Court hearing"},
    {"value": "appointment", "label": "Appointment"},
    {"value": "counselling_session", "label": "Counselling session"},
    {"value": "checkin", "label": "Check-in"},
    {"value": "officer_meeting", "label": "Officer meeting"},
    {"value": "deadline", "label": "Deadline"},
    {"value": "rehabilitation", "label": "Rehabilitation"},
    {"value": "compensation", "label": "Compensation"},
    {"value": "reminder", "label": "Reminder"},
    {"value": "personal_note", "label": "Personal note"},
]
_EVENT_TYPE_VALUES = {e["value"] for e in EVENT_TYPES}


def _can_write(user: User, aura_id: str, db: Session) -> bool:
    if user.aura_id == aura_id:
        return True
    return user.role in ("counsellor", "admin") and can_access_victim(user, aura_id, db)


def _event_out(e: CalendarEvent) -> dict:
    return {
        "id": e.id,
        "aura_id": e.aura_id,
        "title": e.title,
        "event_type": e.event_type,
        "starts_at": e.starts_at.isoformat(),
        "ends_at": e.ends_at.isoformat() if e.ends_at else None,
        "location": e.location,
        "notes": e.notes,
        "created_by_role": e.created_by_role,
        "status": e.status,
    }


class CalendarEventIn(BaseModel):
    aura_id: str
    title: str = Field(min_length=1, max_length=200)
    event_type: str = "appointment"
    starts_at: datetime
    ends_at: Optional[datetime] = None
    location: Optional[str] = None
    notes: Optional[str] = None


class CalendarEventUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=200)
    event_type: Optional[str] = None
    starts_at: Optional[datetime] = None
    ends_at: Optional[datetime] = None
    location: Optional[str] = None
    notes: Optional[str] = None
    status: Optional[str] = None


@router.get("/event-types")
async def event_types():
    return {"success": True, "event_types": EVENT_TYPES}


@router.get("/events")
async def list_events(
    aura_id: str = Query(...),
    start: Optional[datetime] = Query(default=None),
    end: Optional[datetime] = Query(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Events for one case, optionally windowed to [start, end) - the
    Calendar's Month/Week/Day/Agenda views all pass a window; Agenda and
    "next important date" lookups omit it and get everything upcoming."""
    if not can_access_victim(user, aura_id, db):
        raise HTTPException(status_code=403, detail="Not authorised to view this calendar.")
    q = db.query(CalendarEvent).filter(CalendarEvent.aura_id == aura_id)
    if start is not None:
        q = q.filter(CalendarEvent.starts_at >= start)
    if end is not None:
        q = q.filter(CalendarEvent.starts_at < end)
    rows = q.order_by(CalendarEvent.starts_at.asc()).limit(500).all()
    return {"success": True, "events": [_event_out(r) for r in rows]}


@router.get("/overview")
async def list_overview_events(
    start: Optional[datetime] = Query(default=None),
    end: Optional[datetime] = Query(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Events across every case a counsellor/admin/guardian may see - the
    multi-case calendars on their dashboards, backed by the same table and
    the same authorization rule as a single case's calendar (see
    authorized_victim_ids). Admin sees every case in the system; a
    counsellor or guardian sees only their own authorised cases."""
    q = db.query(CalendarEvent)
    if user.role != "admin":
        ids = authorized_victim_ids(user, db)
        if not ids:
            return {"success": True, "events": []}
        q = q.filter(CalendarEvent.aura_id.in_(ids))
    if start is not None:
        q = q.filter(CalendarEvent.starts_at >= start)
    if end is not None:
        q = q.filter(CalendarEvent.starts_at < end)
    rows = q.order_by(CalendarEvent.starts_at.asc()).limit(1000).all()
    return {"success": True, "events": [_event_out(r) for r in rows]}


@router.post("/events")
async def create_event(
    payload: CalendarEventIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not _can_write(user, payload.aura_id, db):
        raise HTTPException(status_code=403, detail="Not authorised to add to this calendar.")
    event_type = payload.event_type if payload.event_type in _EVENT_TYPE_VALUES else "appointment"
    row = CalendarEvent(
        aura_id=payload.aura_id,
        title=payload.title.strip(),
        event_type=event_type,
        starts_at=payload.starts_at,
        ends_at=payload.ends_at,
        location=payload.location,
        notes=payload.notes,
        created_by_user_id=user.id,
        created_by_role=user.role,
    )
    db.add(row)
    db.add(
        AuditLog(
            actor_id=user.id, actor_role=user.role, action="calendar_event_created",
            resource="calendar_event", resource_id=payload.aura_id, reason=event_type,
        )
    )
    db.commit()
    db.refresh(row)
    return {"success": True, "event": _event_out(row)}


@router.put("/events/{event_id}")
async def update_event(
    event_id: str,
    payload: CalendarEventUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    row = db.query(CalendarEvent).filter(CalendarEvent.id == event_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Event not found.")
    if not _can_write(user, row.aura_id, db):
        raise HTTPException(status_code=403, detail="Not authorised to edit this event.")

    if payload.title is not None:
        row.title = payload.title.strip()
    if payload.event_type is not None and payload.event_type in _EVENT_TYPE_VALUES:
        row.event_type = payload.event_type
    if payload.starts_at is not None:
        row.starts_at = payload.starts_at
    if payload.ends_at is not None:
        row.ends_at = payload.ends_at
    if payload.location is not None:
        row.location = payload.location
    if payload.notes is not None:
        row.notes = payload.notes
    if payload.status is not None and payload.status in ("scheduled", "completed", "cancelled"):
        row.status = payload.status
    db.commit()
    db.refresh(row)
    return {"success": True, "event": _event_out(row)}


@router.delete("/events/{event_id}")
async def delete_event(
    event_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    row = db.query(CalendarEvent).filter(CalendarEvent.id == event_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Event not found.")
    if not _can_write(user, row.aura_id, db):
        raise HTTPException(status_code=403, detail="Not authorised to delete this event.")
    db.delete(row)
    db.add(
        AuditLog(
            actor_id=user.id, actor_role=user.role, action="calendar_event_deleted",
            resource="calendar_event", resource_id=row.aura_id, reason=row.title,
        )
    )
    db.commit()
    return {"success": True, "deleted": True}
