"""Personalization signal: did a suggested coping action actually help.

Real per-user data (aura_id-scoped), never inferred - only recorded when the
user answers "did that help?" themselves. This is the raw signal My Patterns
and future recommendations read from.
"""
from typing import List, Literal, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import case, func
from sqlalchemy.orm import Session

from ..database import get_db
from ..database.models import InterventionOutcome, User
from ..security.auth import get_current_user

router = APIRouter(prefix="/api/patterns", tags=["patterns"])

Category = Literal["calm", "reset", "solve", "restore", "connect", "reflect"]
Result = Literal["better", "slightly_better", "same", "worse"]


class OutcomeIn(BaseModel):
    situation: Optional[str] = None
    intervention_category: Category
    intervention_type: str
    result: Result


@router.post("/outcome")
async def record_outcome(
    payload: OutcomeIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    row = InterventionOutcome(aura_id=user.aura_id, **payload.model_dump())
    db.add(row)
    db.commit()
    return {"success": True, "id": row.id}


@router.get("/outcomes")
async def list_outcomes(
    intervention_type: Optional[str] = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    q = db.query(InterventionOutcome).filter(InterventionOutcome.aura_id == user.aura_id)
    if intervention_type:
        q = q.filter(InterventionOutcome.intervention_type == intervention_type)
    rows = q.order_by(InterventionOutcome.created_at.desc()).limit(200).all()
    return {
        "success": True,
        "outcomes": [
            {
                "id": r.id,
                "situation": r.situation,
                "intervention_category": r.intervention_category,
                "intervention_type": r.intervention_type,
                "result": r.result,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ],
    }


@router.get("/what-helps")
async def what_helps(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Aggregates outcomes into a simple ranked "what helps me" list. Needs at
    least a couple of results per intervention before it's shown as a real
    pattern rather than a single lucky/unlucky try."""
    rows: List = (
        db.query(
            InterventionOutcome.intervention_type,
            InterventionOutcome.intervention_category,
            func.count(InterventionOutcome.id).label("total"),
            func.sum(
                case((InterventionOutcome.result.in_(["better", "slightly_better"]), 1), else_=0)
            ).label("helped"),
        )
        .filter(InterventionOutcome.aura_id == user.aura_id)
        .group_by(InterventionOutcome.intervention_type, InterventionOutcome.intervention_category)
        .all()
    )
    ranked = []
    for intervention_type, category, total, helped in rows:
        helped = helped or 0
        if total < 2:
            continue
        ranked.append(
            {
                "intervention_type": intervention_type,
                "intervention_category": category,
                "total": total,
                "helped": helped,
                "helped_ratio": round(helped / total, 2),
            }
        )
    ranked.sort(key=lambda r: (-r["helped_ratio"], -r["total"]))
    return {
        "success": True,
        "has_enough_data": len(ranked) > 0,
        "ranked": ranked,
        "note": "Based on your own past 'did that help?' answers only.",
    }
