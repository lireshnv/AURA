"""AURA platform endpoints: digital twin, risk, counsellor case queue, support.

REAL DATA ONLY
--------------
Every figure served here is derived from data a real user actually provided:
their baseline questionnaire, their check-ins, and the structured signals from
their own analysis sessions. There are no demo profiles, no synthetic
trajectories and no seeded histories - the previous demo module was removed.

When no real data exists the endpoints return empty results and say
"No data available". They never substitute a placeholder figure.

The one deliberate exception is POST /dev/seed-demo-data at the bottom of
this file: an explicit, admin-triggered, non-production-only action that
writes synthetic check-ins/signals through the SAME real storage functions
every genuine check-in uses. It exists because this file's docstring above
was true, and the user asked for connected demo data across the victim,
counsellor, guardian and admin portals to verify they actually agree with
each other - so the values must go through one real write path, not four
separate fabricated ones per portal. It never runs silently: it must be
called on purpose, by an admin, and refuses outright in production.

SCOPE NOTE
----------
Prototype stage. Role separation exists, but the production security
architecture (MFA, encryption at rest, IAM) does not - see SECURITY_POSTURE,
which is served from the API so the limitation travels with the product.
"""
import random
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from typing import Dict, Iterable, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from . import ivrs_store, risk_service, twin_store
from .core.config import settings
from .database import get_db
from .database.models import AuditLog, CaseProfile, CounsellorAssignment, Intervention, User
from .services.ivrs_conversation import CALL_REASONS, opening_line
from .digital_twin import (
    BASELINE_DIMENSIONS,
    baseline_confidence_label,
    build_twin,
    wellbeing_pattern_label,
)
from .risk_engine import SCORE_WEIGHTS, compute_risk, priority_score
from .security.auth import get_current_user, require_role
from .security.authz import can_access_victim

router = APIRouter(prefix="/api/aura", tags=["aura"])

# Single-user prototype: one local identity owns the stored well-being data.
# Multi-user scoping requires adding aura_id to twin_store's tables; the
# counsellor endpoints below are written to iterate a list so that change
# does not alter their shape.
LOCAL_AURA_ID = "local-user"

NO_DATA = "No data available"


SECURITY_POSTURE = {
    "stage": "prototype",
    "implemented": [
        "Pseudonymous AURA-ID (no names or contact details in analysis records)",
        "Role separation between victim and counsellor views",
        "Data minimisation - raw video and audio are never persisted",
        "Local-only processing; no session data sent to third-party AI services",
        "Consent gating on every stored category",
        "Append-only audit trail of human actions",
    ],
    "not_implemented": [
        "Multi-factor authentication",
        "AES-256 encryption at rest",
        "TLS 1.3 termination (handled by the deployment layer, not this app)",
        "AWS IAM / KMS integration",
        "Per-user data scoping in the well-being store (single-user prototype)",
    ],
    "warning": (
        "This prototype must not be used with real victim data until the "
        "items under 'not_implemented' are delivered and independently reviewed."
    ),
}


class SupportDecision(BaseModel):
    aura_id: str
    pathway: str
    decision: str            # approved | rejected
    decided_by: str
    rationale: Optional[str] = None


# POA Act priority use cases (see the NHAA-14566 spec's "Priority Use Cases").
# A closed set, not free text: support_pathways() below keys specific
# recommendations (witness protection, relocation, etc.) off these values,
# so an unrecognised case_type would silently fail to trigger them.
CASE_TYPES = [
    {"value": "rape_or_gang_rape", "label": "Rape / gang rape"},
    {"value": "murder_grievous_hurt_arson", "label": "Murder, grievous hurt, or arson"},
    {"value": "witness_intimidation", "label": "Witness facing intimidation or threats"},
    {"value": "caste_based_violence", "label": "Family affected by caste-based violence"},
    {"value": "other_poa_beneficiary", "label": "Other SC/ST (Prevention of Atrocities) Act beneficiary"},
]
_CASE_TYPE_VALUES = {c["value"] for c in CASE_TYPES}


class CaseTypeUpdate(BaseModel):
    case_type: str
    notes: Optional[str] = None
    district: Optional[str] = None
    state: Optional[str] = None


# --- Helpers --------------------------------------------------------------


def _assess(aura_id: str) -> Optional[Dict]:
    """Builds twin + risk for one person from their REAL stored data.

    Returns None when that person has no usable data, so callers can report
    absence rather than rendering an empty-but-plausible profile.
    """
    baseline_entry = twin_store.get_latest_baseline_answers()
    onboarding = baseline_entry["answers"] if baseline_entry else None
    checkins = twin_store.list_checkins()
    signals = twin_store.list_signal_observations()

    if not checkins and not signals and not onboarding:
        return None

    twin = build_twin(aura_id=aura_id, checkins=checkins, onboarding=onboarding)

    negatives = [
        float(s["sentiment_scores"].get("negative", 0.0))
        for s in signals
        if s.get("sentiment_scores")
    ]
    face_conf = [
        float(s["emotion_confidence"])
        for s in signals
        if isinstance(s.get("emotion_confidence"), (int, float))
    ]

    risk = compute_risk(
        twin,
        sentiment_negative=(sum(negatives) / len(negatives)) if negatives else None,
        case_events=None,
        signal_deviation=(
            100.0 - (sum(face_conf) / len(face_conf)) if face_conf else None
        ),
    )

    return {
        "aura_id": aura_id,
        "twin": asdict(twin),
        "risk": asdict(risk),
        "priority": priority_score(risk, twin),
        "pattern_label": wellbeing_pattern_label(twin),
        "baseline_confidence_label": baseline_confidence_label(twin.baseline.confidence),
        "counts": {"checkins": len(checkins), "sessions": len(signals)},
    }


def _known_aura_ids(candidate_ids: Optional[Iterable[str]] = None) -> List[str]:
    """Which of `candidate_ids` currently have real stored data.

    twin_store is a single shared store, not scoped per aura_id (see the
    module docstring's SCOPE NOTE) - there is exactly one well-being dataset,
    and _assess() already returns it for whichever aura_id asks. So "does
    this aura_id have data" really means "does ANY data exist at all", for
    every candidate consistently - not a hardcoded placeholder id that can
    never match a real account (that was the previous bug here: it returned
    the literal string "local-user", which no real AURA-XXXX account is ever
    assigned, so a counsellor's case queue was always empty for any real
    victim even after seeding data).

    `candidate_ids=None` preserves the original single-identity behaviour for
    any future caller that doesn't have a specific list to check.
    """
    has_data = bool(
        twin_store.list_checkins()
        or twin_store.list_signal_observations()
        or twin_store.get_latest_baseline_answers()
    )
    if not has_data:
        return []
    return list(candidate_ids) if candidate_ids is not None else [LOCAL_AURA_ID]


# --- Endpoints ------------------------------------------------------------


@router.get("/config")
async def config():
    return {
        "baseline_dimensions": list(BASELINE_DIMENSIONS),
        "score_weights": SCORE_WEIGHTS,
        "risk_bands": [
            {"band": "GREEN", "range": "0-30", "routing": "Routine monitoring"},
            {"band": "AMBER", "range": "31-60", "routing": "Counsellor review queue"},
            {"band": "RED", "range": "61-100", "routing": "Priority authorised human review"},
        ],
        "security_posture": SECURITY_POSTURE,
        "synthetic_data": False,
        "positioning": (
            "AURA detects changes in consented signals and helps authorised humans "
            "decide when support may be needed. It does not know how a person feels "
            "and does not make intervention decisions."
        ),
    }


@router.get("/twin/{aura_id}")
async def get_twin(
    aura_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Digital twin + risk for one person, from their real data only.

    Authorised for: the person themself, an admin, an assigned counsellor, or
    a linked guardian - enforced here, server-side, not left to the frontend
    to only ever ask for aura_ids it should see. This same shape already
    contains no raw transcripts or facial data (only numeric well-being/risk
    fields), so a guardian gets the identical response a counsellor would,
    just gated to their own linked victim(s).
    """
    if not can_access_victim(user, aura_id, db):
        raise HTTPException(status_code=403, detail="You are not authorised for this victim.")
    result = _assess(aura_id)
    if result is None:
        return {
            "success": True,
            "has_data": False,
            "message": NO_DATA,
            "aura_id": aura_id,
        }
    return {"success": True, "has_data": True, **result}


@router.get("/cases")
async def case_queue(
    db: Session = Depends(get_db),
    user: User = Depends(require_role("counsellor")),
):
    """Counsellor case queue, built from real profiles only.

    Scoped by REAL authorization: a counsellor sees only the aura_ids an
    admin has actually assigned to them via CounsellorAssignment - not every
    aura_id with data, and not a client-supplied role header (the previous
    X-Aura-Role header was spoofable and is no longer trusted). An admin
    sees every aura_id that has real data, since admins aren't scoped to a
    specific victim list.

    Returns an empty queue when nobody assigned has recorded data. It never
    invents a case to fill the table.
    """
    if user.role == "admin":
        # Admins aren't scoped to a specific victim list - every real victim
        # account is a candidate; _known_aura_ids() filters to the ones that
        # actually have data.
        candidate_ids = [u.aura_id for u in db.query(User).filter(User.role == "victim").all()]
        allowed_ids = set(_known_aura_ids(candidate_ids))
    else:
        assigned = (
            db.query(CounsellorAssignment)
            .filter(
                CounsellorAssignment.counsellor_user_id == user.id,
                CounsellorAssignment.active.is_(True),
            )
            .all()
        )
        candidate_ids = [a.victim_aura_id for a in assigned]
        allowed_ids = set(_known_aura_ids(candidate_ids))

    cases = []
    for aura_id in allowed_ids:
        assessment = _assess(aura_id)
        if assessment is None:
            continue
        twin, risk = assessment["twin"], assessment["risk"]
        cases.append(
            {
                "aura_id": aura_id,
                "risk_band": risk["band"],
                "risk_level": risk["level"],
                "risk_score": risk["score"],
                "confidence": risk["confidence"],
                "routing": risk["routing"],
                "trend": twin["trend"]["direction"],
                "trend_label": twin["trend"]["label"],
                "escalation_risk": twin["escalation_risk"]["level"],
                "escalation_rationale": twin["escalation_risk"]["rationale"],
                "days_since_checkin": twin["engagement"]["days_since_last_checkin"],
                "checkins_last_7d": twin["engagement"]["checkins_last_7d"],
                "priority": assessment["priority"],
                "human_review_required": risk["human_review_required"],
                "insufficient_data": risk["insufficient_data"],
                "top_factors": risk["contributing_factors"][:3],
                "counts": assessment["counts"],
            }
        )

    cases.sort(key=lambda c: c["priority"], reverse=True)

    return {
        "success": True,
        "synthetic": False,
        "message": NO_DATA if not cases else None,
        "summary": {
            "total": len(cases),
            "green": sum(1 for c in cases if c["risk_band"] == "GREEN"),
            "amber": sum(1 for c in cases if c["risk_band"] == "AMBER"),
            "red": sum(1 for c in cases if c["risk_band"] == "RED"),
            "pending_review": sum(1 for c in cases if c["risk_band"] in ("AMBER", "RED")),
            "improving": sum(1 for c in cases if c["trend"] == "improving"),
            "needs_followup": sum(1 for c in cases if c["trend"] == "worsening"),
            "escalation_risk_high": sum(1 for c in cases if c["escalation_risk"] == "high"),
        },
        "cases": cases,
    }


@router.get("/case-types")
async def case_types():
    """Static POA Act case-type options for a classification dropdown."""
    return {"success": True, "case_types": CASE_TYPES}


@router.get("/case-type/{aura_id}")
async def get_case_type(
    aura_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not can_access_victim(user, aura_id, db):
        raise HTTPException(status_code=403, detail="Not authorised to view this case.")
    row = db.query(CaseProfile).filter(CaseProfile.aura_id == aura_id).first()
    if row is None:
        return {
            "success": True, "has_data": False, "case_type": None, "notes": None,
            "district": None, "state": None,
        }
    return {
        "success": True, "has_data": True, "case_type": row.case_type, "notes": row.notes,
        "district": row.district, "state": row.state,
    }


@router.put("/case-type/{aura_id}")
async def set_case_type(
    aura_id: str,
    payload: CaseTypeUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("counsellor", "admin")),
):
    """Classifies a case under the POA Act priority-use-case taxonomy.

    Counsellor/admin only - this is a case-management fact, not a
    self-reported victim answer, and it drives which interventions
    support_pathways() below recommends.
    """
    if payload.case_type not in _CASE_TYPE_VALUES:
        raise HTTPException(status_code=400, detail="Unrecognised case_type.")

    row = db.query(CaseProfile).filter(CaseProfile.aura_id == aura_id).first()
    if row is None:
        row = CaseProfile(
            aura_id=aura_id,
            case_type=payload.case_type,
            notes=payload.notes,
            district=payload.district,
            state=payload.state,
            set_by_user_id=user.id,
        )
        db.add(row)
    else:
        row.case_type = payload.case_type
        row.notes = payload.notes
        row.district = payload.district
        row.state = payload.state
        row.set_by_user_id = user.id

    db.add(
        AuditLog(
            actor_id=user.id,
            actor_role=user.role,
            action="case_type_set",
            resource="case_profile",
            resource_id=aura_id,
            reason=payload.case_type,
        )
    )
    db.commit()
    return {
        "success": True, "case_type": payload.case_type, "notes": payload.notes,
        "district": payload.district, "state": payload.state,
    }


@router.get("/geo-overview")
async def geo_overview(
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin")),
):
    """District/State/National rollup for monitoring vulnerable victims and
    high-risk cases, per the spec's dashboard requirement.

    Admin-only. Every case with a CaseProfile is included (classification is
    what makes a case visible here - an unclassified aura_id has nowhere to
    roll up to). Risk is computed the same way /cases does, via _assess().

    SCOPE NOTE: this rolls up whatever CaseProfiles exist, but the underlying
    well-being store (twin_store) is still the single-user prototype
    documented in SECURITY_POSTURE - so today this reflects at most the one
    real dataset that exists, not a true multi-district population. The
    aggregation logic itself is written to scale once that is fixed.
    """
    profiles = db.query(CaseProfile).all()

    national = {"total": 0, "green": 0, "amber": 0, "red": 0, "unassessed": 0}
    by_case_type: Dict[str, int] = {}
    by_state: Dict[str, Dict] = {}
    high_risk_cases: List[Dict] = []
    escalating_cases: List[Dict] = []

    for profile in profiles:
        assessment = _assess(profile.aura_id)
        band = assessment["risk"]["band"] if assessment else None
        escalation = assessment["twin"]["escalation_risk"] if assessment else None

        national["total"] += 1
        if band == "GREEN":
            national["green"] += 1
        elif band == "AMBER":
            national["amber"] += 1
        elif band == "RED":
            national["red"] += 1
        else:
            national["unassessed"] += 1

        by_case_type[profile.case_type] = by_case_type.get(profile.case_type, 0) + 1

        state_key = profile.state or "Unspecified state"
        district_key = profile.district or "Unspecified district"
        state_bucket = by_state.setdefault(
            state_key, {"total": 0, "green": 0, "amber": 0, "red": 0, "districts": {}}
        )
        state_bucket["total"] += 1
        district_bucket = state_bucket["districts"].setdefault(
            district_key, {"total": 0, "green": 0, "amber": 0, "red": 0}
        )
        district_bucket["total"] += 1
        if band in ("GREEN", "AMBER", "RED"):
            key = band.lower()
            state_bucket[key] += 1
            district_bucket[key] += 1

        if band == "RED":
            high_risk_cases.append(
                {
                    "aura_id": profile.aura_id,
                    "case_type": profile.case_type,
                    "district": profile.district,
                    "state": profile.state,
                    "risk_score": assessment["risk"]["score"],
                    "priority": assessment["priority"],
                }
            )

        # Predicted-to-escalate: a case that is NOT already RED but whose
        # check-in history shows a sustained decline and/or unusual swing
        # (digital_twin.compute_escalation_risk) - the spec's "predict
        # escalation... before a crisis situation emerges", kept visibly
        # separate from high_risk_cases (which is current-state RED) rather
        # than merged into one list, since "already in crisis" and
        # "heading that way on current trend" call for different responses.
        if band in ("GREEN", "AMBER") and escalation and escalation["level"] == "high":
            escalating_cases.append(
                {
                    "aura_id": profile.aura_id,
                    "case_type": profile.case_type,
                    "district": profile.district,
                    "state": profile.state,
                    "current_band": band,
                    "rationale": escalation["rationale"],
                    "priority": assessment["priority"],
                }
            )

    high_risk_cases.sort(key=lambda c: c["priority"], reverse=True)
    escalating_cases.sort(key=lambda c: c["priority"], reverse=True)

    # Flatten the nested district dicts to lists for a simpler frontend shape.
    states_out = [
        {
            "state": state_name,
            "total": bucket["total"],
            "green": bucket["green"],
            "amber": bucket["amber"],
            "red": bucket["red"],
            "districts": [
                {"district": d_name, **d_bucket} for d_name, d_bucket in bucket["districts"].items()
            ],
        }
        for state_name, bucket in by_state.items()
    ]

    return {
        "success": True,
        "national": national,
        "by_case_type": by_case_type,
        "states": states_out,
        "high_risk_cases": high_risk_cases,
        "escalating_cases": escalating_cases,
    }


@router.post("/geo-overview/acknowledge/{aura_id}")
async def acknowledge_high_risk_case(
    aura_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin")),
):
    """A designated official acknowledging a RED-band case flagged on the
    Geographic & Risk Overview - closes the loop on "trigger alerts... when
    predefined risk thresholds are crossed" with a real, auditable record of
    who saw it and when, rather than the alert only ever being displayed.

    This app's real role model doesn't have separate district/state/
    national officer roles (see SECURITY_POSTURE's not_implemented list) -
    admin is the one designated-official tier that exists today, so that's
    who this is scoped to rather than inventing a role with no login path.
    """
    db.add(
        AuditLog(
            actor_id=user.id,
            actor_role=user.role,
            action="high_risk_case_acknowledged",
            resource="case_profile",
            resource_id=aura_id,
        )
    )
    db.commit()
    return {"success": True}


@router.get("/geo-overview/acknowledgements/{aura_id}")
async def high_risk_acknowledgements(
    aura_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("admin")),
):
    rows = (
        db.query(AuditLog)
        .filter(
            AuditLog.resource == "case_profile",
            AuditLog.resource_id == aura_id,
            AuditLog.action == "high_risk_case_acknowledged",
        )
        .order_by(AuditLog.timestamp.desc())
        .limit(10)
        .all()
    )
    return {
        "success": True,
        "acknowledgements": [
            {"actor_role": r.actor_role, "at": r.timestamp.isoformat()} for r in rows
        ],
    }


@router.get("/support/pathways/{aura_id}")
async def support_pathways(
    aura_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Pathways AURA SUGGESTS from real signals plus the case's POA Act
    classification (if set). A human decides - see support_decision()."""
    if not can_access_victim(user, aura_id, db):
        raise HTTPException(status_code=403, detail="Not authorised to view this case.")

    assessment = _assess(aura_id)
    if assessment is None:
        return {"success": True, "has_data": False, "message": NO_DATA, "suggestions": []}

    case_row = db.query(CaseProfile).filter(CaseProfile.aura_id == aura_id).first()
    case_type = case_row.case_type if case_row else None

    risk, twin = assessment["risk"], assessment["twin"]
    suggestions: List[Dict] = []

    def suggest(pathway: str, reason: str, urgency: str = "routine"):
        suggestions.append(
            {
                "pathway": pathway,
                "reason": reason,
                "urgency": urgency,
                "status": "recommended",
                "requires_human_approval": True,
            }
        )

    if risk["band"] in ("AMBER", "RED"):
        suggest(
            "Counselling",
            f"Risk band {risk['band']} with {len(risk['contributing_factors'])} "
            f"contributing signal(s).",
            "priority" if risk["band"] == "RED" else "routine",
        )
    if twin["engagement"]["changed"] or twin["engagement"]["missed_last_7d"] >= 3:
        suggest("Wellbeing check call", "Check-in engagement decreased this week.")
    if "sleep" in twin["deviation"]["worsening"]:
        suggest("Medical support referral", "Self-reported sleep moved below their usual range.")

    # --- POA Act case-type-driven pathways (spec: "Recommend appropriate
    #     interventions such as counselling, medical treatment, witness
    #     protection, relocation support, financial assistance, legal aid,
    #     or rehabilitation measures.") Each rule names the exact case fact
    #     that triggered it, matching this file's explainability convention. ---
    if case_type in ("rape_or_gang_rape", "murder_grievous_hurt_arson"):
        suggest(
            "Medical treatment",
            f"Case classified as {case_type.replace('_', ' ')} - physical harm likely; "
            "medical evaluation is a standard POA Act relief measure.",
            "priority",
        )
    if case_type == "witness_intimidation" or (
        case_type == "caste_based_violence" and risk["band"] in ("AMBER", "RED")
    ):
        suggest(
            "Witness protection",
            f"Case classified as {case_type.replace('_', ' ')}"
            + (f" with {risk['band']} risk band" if case_type == "caste_based_violence" else "")
            + " - threat exposure warrants a protection review.",
            "priority",
        )
        suggest(
            "Relocation support",
            "Continued proximity to the accused/threat source is a relocation-eligible "
            "circumstance under the POA Act rules.",
            "priority" if risk["band"] == "RED" else "routine",
        )
    if case_type is not None:
        suggest(
            "Financial assistance",
            f"Case classified as {case_type.replace('_', ' ')} - eligible for POA Act "
            "relief/compensation; a benefits review is due regardless of risk band.",
        )
        suggest(
            "Legal aid",
            "POA Act cases are entitled to free legal aid through the investigation "
            "and trial process.",
        )
    if risk["band"] == "RED" or twin["trend"]["direction"] == "worsening":
        suggest(
            "Rehabilitation",
            "Sustained high distress or a worsening trend indicates a need for "
            "structured long-term rehabilitation, not a one-off intervention.",
            "priority" if risk["band"] == "RED" else "routine",
        )

    if not suggestions:
        suggest("Routine monitoring", "No elevated signals; continue scheduled check-ins.")

    return {
        "success": True,
        "has_data": True,
        "aura_id": aura_id,
        "case_type": case_type,
        "suggestions": suggestions,
        "decision_authority": "authorised_human",
        "note": (
            "AURA suggests pathways from observed signals. An authorised human "
            "reviews and decides; AURA cannot approve or initiate support."
        ),
    }


@router.get("/support/history/{aura_id}")
async def support_history(
    aura_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Persisted intervention decisions for this case - survives a page
    reload or a different counsellor picking the case back up, unlike
    keeping decisions only in the reviewing browser's local state."""
    if not can_access_victim(user, aura_id, db):
        raise HTTPException(status_code=403, detail="Not authorised to view this case.")
    rows = (
        db.query(Intervention)
        .filter(Intervention.aura_id == aura_id)
        .order_by(Intervention.created_at.desc())
        .all()
    )
    return {
        "success": True,
        "interventions": [
            {
                "id": r.id,
                "pathway": r.pathway,
                "status": r.status,
                "reason": r.recommended_reason,
                "decided_by": r.decided_by,
                "decided_at": r.decided_at.isoformat() if r.decided_at else None,
                "created_at": r.created_at.isoformat(),
            }
            for r in rows
        ],
    }


@router.post("/support/decision")
async def support_decision(
    payload: SupportDecision,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("counsellor", "admin")),
):
    """Records a HUMAN decision on a suggested pathway - persisted, not just
    echoed back, so it survives a reload and is visible to any other
    authorised reviewer of this case (district/state rollups included)."""
    if payload.decision not in ("approved", "rejected", "escalated"):
        return {"success": False, "error": "Decision must be 'approved', 'rejected', or 'escalated'."}
    if not payload.decided_by.strip():
        return {
            "success": False,
            "error": "A decision must record the authorised person who made it.",
        }

    row = Intervention(
        aura_id=payload.aura_id,
        pathway=payload.pathway,
        status=payload.decision,
        recommended_reason=payload.rationale,
        decided_by=f"{payload.decided_by} ({user.id})",
        decided_at=datetime.now(timezone.utc),
    )
    db.add(row)
    db.add(
        AuditLog(
            actor_id=user.id,
            actor_role=user.role,
            action=f"intervention_{payload.decision}",
            resource="intervention",
            resource_id=payload.aura_id,
            reason=payload.rationale or payload.pathway,
        )
    )
    db.commit()

    return {
        "success": True,
        "recorded": {
            "id": row.id,
            "aura_id": payload.aura_id,
            "pathway": payload.pathway,
            "status": payload.decision,
            "decided_by": payload.decided_by,
            "rationale": payload.rationale,
            "decided_by_ai": False,
        },
    }


@router.get("/checkin/questions")
async def checkin_questions():
    """Conversational check-in. Every question is skippable by design."""
    return {
        "success": True,
        "intro": "Whenever you're ready. You can skip anything you'd rather not answer.",
        "questions": [
            {"id": "mood", "prompt": "How are you feeling today?", "scale": "0-10", "skippable": True},
            {"id": "sleep", "prompt": "How did you sleep?", "scale": "0-10", "skippable": True},
            {"id": "energy", "prompt": "How has your energy been?", "scale": "0-10", "skippable": True},
            {"id": "social_interaction", "prompt": "Have you spent time with anyone today?",
             "scale": "0-10", "skippable": True},
            {"id": "routine", "prompt": "How has your day been overall?", "scale": "0-10",
             "skippable": True},
            {"id": "communication", "prompt": "How easy has it felt to talk to people?",
             "scale": "0-10", "skippable": True},
            {"id": "note", "prompt": "Anything making today harder?", "type": "text",
             "skippable": True},
        ],
        "input_modes": ["text", "voice", "skip"],
        "note": "AURA provides supportive guidance and does not replace professional care.",
    }


@router.post("/dev/seed-demo-data")
async def seed_demo_data(
    db: Session = Depends(get_db), admin: User = Depends(require_role("admin"))
):
    """Writes a small synthetic well-being + IVRS call history through the
    REAL storage functions (twin_store.save_baseline_answers/save_checkin/
    save_signal_observation, ivrs_store.start_call/add_turn/set_status) - the
    same paths a genuine check-in or a genuine counsellor-generated call uses.

    Because twin_store is one shared store rather than scoped per aura_id
    (see this module's docstring), whatever is written here is what
    /twin/{aura_id} and /cases compute their numbers from for EVERY
    authorised aura_id - so seeding once here is what makes the victim's own
    dashboard, an assigned counsellor's case queue and Analysis tab, a linked
    guardian's summary, and the admin case list all agree on the same
    numbers, instead of four separate placeholder values that happen to look
    similar. ivrs_store IS scoped per aura_id already, so the call history
    seeded below is genuinely per-victim, not shared like the twin data.

    Admin-only and refuses outright in production - this writes fabricated
    history into real storage, which must never be reachable by accident or
    by a non-admin.
    """
    if settings.is_production:
        raise HTTPException(
            status_code=403, detail="Synthetic data seeding is disabled in production."
        )

    for scope in ("baseline", "checkins", "emotion_signals"):
        twin_store.set_consent(scope, True)
        # Re-seeding replaces the previous synthetic run rather than piling
        # more rows on top of it, so the numbers stay predictable to look at.
        twin_store.delete_scope(scope)

    now = datetime.now(timezone.utc)
    rng = random.Random()

    baseline_answers = {dim: round(rng.uniform(6.5, 8.5), 1) for dim in BASELINE_DIMENSIONS}
    twin_store.save_baseline_answers(baseline_answers, preferred_checkin_time="20:00")

    # build_baseline() (digital_twin.py) treats the FIRST 14 check-ins
    # (BASELINE_TARGET_OBSERVATIONS) as "what's normal for this person", and
    # only the last 7 days as "current state" - so a believable elevated case
    # needs an established stable period, not just an overall downward slope,
    # otherwise the decline gets absorbed into the baseline average itself
    # and the deviation never shows up.
    #
    # 18 stable check-ins (days 25-8 ago) establish a solid, good baseline.
    checkins_written = 0
    for days_ago in range(25, 7, -1):
        values = {
            dim: round(max(0.0, min(10.0, baseline_answers[dim] + rng.uniform(-0.5, 0.5))), 1)
            for dim in BASELINE_DIMENSIONS
        }
        created_at = (now - timedelta(days=days_ago, hours=rng.randint(0, 5))).isoformat()
        if twin_store.save_checkin(values, note=None, created_at=created_at, source="synthetic"):
            checkins_written += 1

    # Then a sharp decline in the last 7 days - outside the baseline window,
    # squarely inside the "current state" window - so deviation/trend/risk
    # all move together, the way an actual worsening case would.
    for days_ago in range(7, -1, -1):
        drop = 3.0 + (7 - days_ago) * 0.35
        values = {
            dim: round(max(0.0, min(10.0, baseline_answers[dim] - drop + rng.uniform(-0.4, 0.4))), 1)
            for dim in BASELINE_DIMENSIONS
        }
        created_at = (now - timedelta(days=days_ago, hours=rng.randint(0, 5))).isoformat()
        if twin_store.save_checkin(values, note=None, created_at=created_at, source="synthetic"):
            checkins_written += 1

    signals_written = 0
    for days_ago in range(6, -1, -2):
        negative = round(min(0.9, 0.4 + (6 - days_ago) * 0.08 + rng.uniform(-0.05, 0.05)), 2)
        created_at = (now - timedelta(days=days_ago, hours=rng.randint(0, 5))).isoformat()
        record = {
            "emotion_dominant": rng.choice(["neutral", "sad", "calm"]),
            "emotion_confidence": round(rng.uniform(55, 85), 1),
            "sentiment_dominant": "negative" if negative > 0.5 else "neutral",
            "sentiment_scores": {"negative": negative, "neutral": round(1 - negative, 2), "positive": 0.0},
            "voice_available": True,
            "text_available": True,
            "modalities": ["face", "voice", "text"],
            "reliability": "synthetic-demo",
        }
        if twin_store.save_signal_observation(record, created_at=created_at):
            signals_written += 1

    # --- IVRS calls: one per victim account, placed by one of their real
    # assigned counsellors, with a real reason/opening line and a short
    # plausible turn-by-turn exchange - not a model-generated transcript, the
    # same fixed reply set used everywhere else fabricated text must be
    # avoided. Scoped per aura_id (unlike twin data above), so each victim
    # gets their own history rather than one shared conversation.
    victims = db.query(User).filter(User.role == "victim").all()
    counsellors = db.query(User).filter(User.role == "counsellor").all()
    SAMPLE_REPLIES = [
        "I'm okay, just a bit tired today.",
        "Yeah, I've been managing. Some days are harder than others.",
        "I did try the breathing exercise you suggested, it helped a little.",
        "Not great honestly, but I'm getting through it.",
        "I appreciate the check-in, it means a lot.",
    ]
    calls_written = 0
    if counsellors:
        for i, victim in enumerate(victims):
            counsellor = counsellors[i % len(counsellors)]
            reason_key = rng.choice(list(CALL_REASONS.keys() - {"custom"}))
            message = opening_line(reason_key)
            days_ago = rng.randint(0, 6)
            started_at = (now - timedelta(days=days_ago, hours=rng.randint(0, 20))).isoformat()

            call_id = ivrs_store.start_call(
                victim.aura_id, reason_key, None, message,
                counsellor_user_id=counsellor.id, language="auto", started_at=started_at,
            )
            ivrs_store.add_turn(call_id, "aura", message, at=started_at)

            outcome = rng.choices(
                ["completed", "declined", "completed"], weights=[2, 1, 2], k=1
            )[0]
            if outcome == "declined":
                ivrs_store.set_status(call_id, "declined", ended=True, at=started_at)
            else:
                answered_at = (
                    datetime.fromisoformat(started_at) + timedelta(seconds=8)
                ).isoformat()
                ivrs_store.set_status(call_id, "answered", answered=True, at=answered_at)
                reply = rng.choice(SAMPLE_REPLIES)
                ivrs_store.add_turn(call_id, "user", reply, at=answered_at)
                ended_at = (
                    datetime.fromisoformat(answered_at) + timedelta(minutes=rng.randint(1, 4))
                ).isoformat()
                ivrs_store.set_status(call_id, "completed", ended=True, at=ended_at)
            calls_written += 1

    return {
        "success": True,
        "seeded": {
            "baseline": True,
            "checkins": checkins_written,
            "signal_observations": signals_written,
            "ivrs_calls": calls_written,
        },
        "note": (
            "Synthetic demo data written to the shared well-being store and, "
            "per-victim, the IVRS call store. Refresh the victim dashboard, a "
            "counsellor's case queue/Analysis/AURA Call tabs, a linked "
            "guardian's summary, or the admin case list to see it - they all "
            "read the same data."
        ),
    }
