"""API contracts for the Personal Well-being Digital Twin.

    /api/twin/consent      - grant / withdraw / inspect consent
    /api/twin/baseline     - submit the baseline questionnaire
    /api/twin/checkin      - submit a real daily check-in
    /api/twin/ingest       - receive structured signals from the dashboard
    /api/twin/view         - the assembled My Well-being view
    /api/twin/trends       - trend windows + daily series
    /api/twin/privacy      - what is stored, export, delete

All payloads are Pydantic-validated. Every write is consent-gated and returns
an explicit reason when consent is missing, rather than failing silently.
"""
from typing import Dict, List, Literal, Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

from . import twin_service, twin_store

router = APIRouter(prefix="/api/twin", tags=["digital-twin"])


# --- Schemas ---------------------------------------------------------------


class ConsentUpdate(BaseModel):
    scope: str
    granted: bool


class BaselineSubmission(BaseModel):
    """Baseline questionnaire. Every field optional - the user may answer only
    what they are comfortable with, and partial answers still build a baseline."""

    sleep: Optional[float] = Field(default=None, ge=0, le=10)
    energy: Optional[float] = Field(default=None, ge=0, le=10)
    mood: Optional[float] = Field(default=None, ge=0, le=10)
    routine: Optional[float] = Field(default=None, ge=0, le=10)
    social_interaction: Optional[float] = Field(default=None, ge=0, le=10)
    communication: Optional[float] = Field(default=None, ge=0, le=10)
    activity_level: Optional[float] = Field(default=None, ge=0, le=10)
    preferred_checkin_time: Optional[str] = None


class CheckinSubmission(BaseModel):
    sleep: Optional[float] = Field(default=None, ge=0, le=10)
    energy: Optional[float] = Field(default=None, ge=0, le=10)
    mood: Optional[float] = Field(default=None, ge=0, le=10)
    routine: Optional[float] = Field(default=None, ge=0, le=10)
    social_interaction: Optional[float] = Field(default=None, ge=0, le=10)
    communication: Optional[float] = Field(default=None, ge=0, le=10)
    # Free-form context tags from the quick check-in flow (e.g. "Work",
    # "Sleep", "Relationships") - not a scored dimension, just a label the
    # Insights page can later correlate against reported mood/stress.
    categories: Optional[List[str]] = None
    # The plain-language feeling label the user tapped (e.g. "Good", "Low",
    # "Anxious") from the quick check-in - kept alongside the numeric `mood`
    # score so the UI can echo back exactly what the user chose.
    feeling: Optional[str] = None
    note: Optional[str] = None
    skipped: bool = False


class CareActionSubmission(BaseModel):
    kind: Literal["feed", "water", "activity"]
    activity_type: Optional[Literal["breathing", "journaling", "walking", "relaxation"]] = None


class SignalIngest(BaseModel):
    """Structured output from the existing emotion dashboard.

    Derived signals only - this schema deliberately has no field capable of
    carrying a frame, an audio buffer or transcript text.
    """

    emotion_dominant: Optional[str] = None
    emotion_confidence: Optional[float] = None
    emotion_scores: Dict[str, float] = {}
    sentiment_dominant: Optional[str] = None
    sentiment_scores: Dict[str, float] = {}
    voice_available: bool = False
    text_available: bool = False
    modalities: List[str] = []
    reliability: Optional[float] = None
    session_id: Optional[str] = None


# --- Consent ---------------------------------------------------------------


@router.get("/consent")
async def get_consent():
    return {
        "success": True,
        "consent": twin_store.get_consent(),
        "scopes": {
            "baseline": "Store your baseline questionnaire answers.",
            "checkins": "Store your daily check-in responses.",
            "emotion_signals": "Store derived signals from camera/voice sessions "
                               "(scores only - never video, audio or transcript text).",
            "session_history": "Keep past sessions so trends can be shown over time.",
            "companion_care": "Store Companion daily-care actions (feed/water/activity) "
                               "so your pet/plant reflects real completed actions.",
        },
    }


@router.post("/consent")
async def update_consent(payload: ConsentUpdate):
    if payload.scope not in twin_store.CONSENT_SCOPES:
        return {"success": False, "error": f"Unknown consent scope: {payload.scope}"}
    ok = twin_store.set_consent(payload.scope, payload.granted)
    return {"success": ok, "consent": twin_store.get_consent()}


# --- Baseline --------------------------------------------------------------


@router.get("/baseline/questions")
async def baseline_questions():
    """Conversational baseline questions. Nothing is required."""
    return {
        "success": True,
        "intro": "A few questions about what's normal for you. Answer only what you'd like to.",
        "questions": [
            {"id": "sleep", "prompt": "How has your sleep been recently?",
             "low": "Poor", "high": "Good", "type": "slider"},
            {"id": "energy", "prompt": "How are your energy levels usually?",
             "low": "Low", "high": "High", "type": "slider"},
            {"id": "mood", "prompt": "How would you describe your general mood?",
             "low": "Low", "high": "Good", "type": "slider"},
            {"id": "routine", "prompt": "How settled is your daily routine?",
             "low": "Unsettled", "high": "Settled", "type": "slider"},
            {"id": "social_interaction", "prompt": "How often do you spend time with others?",
             "low": "Rarely", "high": "Often", "type": "slider"},
            {"id": "communication", "prompt": "How easy do you usually find it to talk to people?",
             "low": "Difficult", "high": "Easy", "type": "slider"},
            {"id": "activity_level", "prompt": "How active are your days usually?",
             "low": "Quiet", "high": "Active", "type": "slider"},
            {"id": "preferred_checkin_time", "prompt": "When would you prefer to check in?",
             "type": "choice", "options": ["Morning", "Afternoon", "Evening", "No preference"]},
        ],
        "note": "These answers describe your normal. They are not a health assessment.",
    }


@router.post("/baseline")
async def submit_baseline(payload: BaselineSubmission):
    if not twin_store.has_consent("baseline"):
        return {
            "success": False,
            "error": "Consent to store baseline answers has not been granted.",
            "required_consent": "baseline",
        }

    data = payload.model_dump(exclude_none=True)
    preferred = data.pop("preferred_checkin_time", None)
    if not data:
        return {"success": False, "error": "No answers were provided."}

    entry_id = twin_store.save_baseline_answers(data, preferred)
    return {
        "success": entry_id is not None,
        "id": entry_id,
        "answers_recorded": len(data),
        "note": "Your baseline will strengthen as you complete more check-ins.",
    }


# --- Check-ins -------------------------------------------------------------


@router.post("/checkin")
async def submit_checkin(payload: CheckinSubmission):
    if not twin_store.has_consent("checkins"):
        return {
            "success": False,
            "error": "Consent to store check-ins has not been granted.",
            "required_consent": "checkins",
        }

    data = payload.model_dump(exclude_none=True)
    note = data.pop("note", None)
    skipped = data.pop("skipped", False)

    entry_id = twin_store.save_checkin(data, note=note, skipped=skipped)
    return {"success": entry_id is not None, "id": entry_id, "values_recorded": len(data)}


@router.get("/checkins")
async def list_checkins(days: Optional[int] = None):
    checkins = twin_store.list_checkins(days)
    return {"success": True, "count": len(checkins), "checkins": checkins}


# --- Companion daily care (feed / water / activity) -------------------------


@router.post("/care/action")
async def submit_care_action(payload: CareActionSubmission):
    """Records one real completed Companion action. Requires 'companion_care'
    consent. Check-ins are submitted through /api/twin/checkin instead."""
    if not twin_store.has_consent("companion_care"):
        return {
            "success": False,
            "error": "Consent to store Companion care actions has not been granted.",
            "required_consent": "companion_care",
        }
    entry_id = twin_store.save_care_action(payload.kind, payload.activity_type)
    if entry_id is None:
        return {"success": False, "error": "Could not record this action."}
    return {"success": True, "id": entry_id, **twin_service.get_care_summary()}


@router.get("/care/today")
async def care_today():
    return twin_service.get_care_summary()


# --- Ingestion from the emotion dashboard ---------------------------------


@router.post("/ingest")
async def ingest(payload: SignalIngest):
    """Receives structured signals from the existing analysis pipeline.

    The dashboard keeps working identically whether or not this succeeds - a
    refused ingest (no consent) never interrupts analysis.
    """
    return {"success": True, **twin_service.ingest_session_signals(payload.model_dump())}


# --- Views -----------------------------------------------------------------


@router.get("/view")
async def twin_view():
    return twin_service.get_twin_view()


@router.get("/trends")
async def trends():
    return {
        "success": True,
        "windows": twin_service.build_trends(),
        "series": twin_service.build_series(),
        "note": "Days without data are omitted rather than shown as zero.",
    }


# --- Privacy control -------------------------------------------------------


@router.get("/privacy")
async def privacy():
    return {
        "success": True,
        "consent": twin_store.get_consent(),
        "stored": twin_store.data_summary(),
        "what_we_collect": [
            "Baseline questionnaire answers you provide",
            "Daily check-in responses you provide",
            "Derived scores from camera/voice sessions (numbers and labels only)",
        ],
        "what_we_never_store": [
            "Camera video or still frames",
            "Microphone audio",
            "Transcript text of what you said",
        ],
        "why": "To compare your current signals against your own baseline over time.",
        "who_can_access": "Only you, on this device. No data is sent to third-party services.",
    }


@router.get("/privacy/export")
async def export_data():
    return {"success": True, "export": twin_store.export_all()}


@router.delete("/privacy/scope/{scope}")
async def delete_scope(scope: str):
    deleted = twin_store.delete_scope(scope)
    return {"success": True, "scope": scope, "deleted": deleted}


@router.delete("/privacy/all")
async def delete_everything():
    """Deletes every stored record and revokes all consent."""
    deleted = twin_store.delete_all()
    return {
        "success": True,
        "deleted": deleted,
        "consent": twin_store.get_consent(),
        "note": "All stored well-being data has been permanently deleted.",
    }
