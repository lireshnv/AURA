"""Cross-router authorization: "may this authenticated user see this
victim's data?" - the single real check behind counsellor and guardian
access, used by aura_api.py, sos.py and ivrs.py alike so the rule lives in
one place instead of being re-implemented (and possibly re-implemented
wrong) per router.
"""
from sqlalchemy.orm import Session

from ..database.models import CounsellorAssignment, GuardianVictimLink, User


def can_access_victim(user: User, victim_aura_id: str, db: Session) -> bool:
    """True if `user` may view `victim_aura_id`'s data:

    - the victim viewing their own data
    - an admin (unrestricted, for operational/support purposes)
    - a counsellor with an active CounsellorAssignment to this victim
    - a guardian with an active GuardianVictimLink to this victim
    """
    if user.aura_id == victim_aura_id:
        return True
    if user.role == "admin":
        return True
    if user.role == "counsellor":
        return (
            db.query(CounsellorAssignment)
            .filter(
                CounsellorAssignment.counsellor_user_id == user.id,
                CounsellorAssignment.victim_aura_id == victim_aura_id,
                CounsellorAssignment.active.is_(True),
            )
            .first()
            is not None
        )
    if user.role == "guardian":
        return (
            db.query(GuardianVictimLink)
            .filter(
                GuardianVictimLink.guardian_user_id == user.id,
                GuardianVictimLink.victim_aura_id == victim_aura_id,
                GuardianVictimLink.active.is_(True),
            )
            .first()
            is not None
        )
    return False


def authorized_victim_ids(user: User, db: Session) -> set[str]:
    """All victim aura_ids this user may see. Admin gets an empty set back
    here (its meaning is "unrestricted" - callers check user.role == "admin"
    separately rather than reading this as an allow-list for admins)."""
    if user.role == "counsellor":
        rows = (
            db.query(CounsellorAssignment)
            .filter(
                CounsellorAssignment.counsellor_user_id == user.id,
                CounsellorAssignment.active.is_(True),
            )
            .all()
        )
        return {r.victim_aura_id for r in rows}
    if user.role == "guardian":
        rows = (
            db.query(GuardianVictimLink)
            .filter(
                GuardianVictimLink.guardian_user_id == user.id,
                GuardianVictimLink.active.is_(True),
            )
            .all()
        )
        return {r.victim_aura_id for r in rows}
    if user.role == "victim":
        return {user.aura_id}
    return set()


def resolve_subject_aura_id(user: User, requested: str | None, db: Session) -> str:
    """Whose well-being data a request may read.

    A victim always gets their own aura_id - any `requested` value is ignored,
    so a victim can never read another person's data by changing a query
    parameter. Every other role must name the victim explicitly and be
    authorized for them (assigned counsellor, linked guardian, or admin).
    """
    from fastapi import HTTPException

    if user.role == "victim":
        if not user.aura_id:
            raise HTTPException(status_code=403, detail="This account has no AURA ID.")
        return user.aura_id
    if not requested:
        raise HTTPException(status_code=400, detail="aura_id is required for this role.")
    if not can_access_victim(user, requested, db):
        raise HTTPException(status_code=403, detail="Not authorized for this case.")
    return requested


def require_own_aura_id(user: User) -> str:
    """Writes to someone's well-being record (check-ins, consent, baseline,
    deletion) are only ever made by that person themselves."""
    from fastapi import HTTPException

    if user.role != "victim" or not user.aura_id:
        raise HTTPException(status_code=403, detail="Only the person themselves can change this data.")
    return user.aura_id
