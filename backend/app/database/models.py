"""SQLAlchemy ORM models for the AURA core.

IDENTITY / ANALYSIS SEPARATION
------------------------------
The schema deliberately splits two things apart:

  * `users` holds identity - email, password hash, role. It is the ONLY table
    containing anything personally identifying.
  * every analysis table keys off `aura_id`, a pseudonymous identifier, and
    holds no name, email or contact detail.

So an AI service can be handed analysis rows without ever receiving identity
data, and a breach of the analysis tables alone does not identify anyone.

WHAT IS NOT STORED
------------------
No table here has a column capable of holding a video frame, an audio buffer,
or a raw password. Transcript text is stored only where the user consented to
it and is deletable per-scope.
"""
import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from . import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )


# --- Identity --------------------------------------------------------------


class User(Base, TimestampMixin):
    """Identity only. Analysis data never joins directly to this table -
    it joins on aura_id, which is the pseudonymous bridge."""

    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(20), default="victim", index=True)

    # Google's stable per-account subject identifier - the minimum needed to
    # recognise "this is the same person" on a later Google sign-in. Null for
    # accounts that have never used Google sign-in. Never the email alone,
    # since Google accounts can change their email.
    google_sub: Mapped[str | None] = mapped_column(String(64), unique=True, index=True, nullable=True)

    # Pseudonymous identifier used everywhere outside this table.
    aura_id: Mapped[str] = mapped_column(String(40), unique=True, index=True)

    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    # MFA-ready: the columns exist so enabling TOTP later needs no migration
    # of live data, but no MFA verification is implemented yet.
    mfa_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    mfa_secret: Mapped[str | None] = mapped_column(String(64), nullable=True)

    last_login_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    failed_login_count: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    profile: Mapped["Profile"] = relationship(
        back_populates="user", cascade="all, delete-orphan", uselist=False
    )
    auth_sessions: Mapped[list["AuthSession"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


class Profile(Base, TimestampMixin):
    """Optional non-sensitive display data. Separate from User so identity
    columns stay in one auditable place."""

    __tablename__ = "profiles"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), unique=True
    )
    display_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    preferred_language: Mapped[str] = mapped_column(String(10), default="auto")
    preferred_checkin_time: Mapped[str | None] = mapped_column(String(20), nullable=True)

    # Short, role-specific onboarding survey answered once after first login.
    # Real free-text/short answers the person actually gave - never seeded.
    onboarding_complete: Mapped[bool] = mapped_column(Boolean, default=False)
    onboarding_data: Mapped[dict] = mapped_column(JSON, default=dict)

    user: Mapped[User] = relationship(back_populates="profile")


class VictimProfile(Base, TimestampMixin):
    """Structured, victim-specific onboarding answers - separate from the
    generic Profile (display name/language, shared by every role) so a
    victim's fields don't sit next to a counsellor's or guardian's in the
    same untyped JSON blob."""

    __tablename__ = "victim_profiles"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), unique=True, index=True
    )
    goal: Mapped[str | None] = mapped_column(Text, nullable=True)


class CounsellorProfile(Base, TimestampMixin):
    __tablename__ = "counsellor_profiles"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), unique=True, index=True
    )
    title: Mapped[str | None] = mapped_column(String(120), nullable=True)
    focus_area: Mapped[str | None] = mapped_column(String(200), nullable=True)


class GuardianProfile(Base, TimestampMixin):
    __tablename__ = "guardian_profiles"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), unique=True, index=True
    )
    relationship_to_victim: Mapped[str | None] = mapped_column(String(120), nullable=True)


class AuthSession(Base, TimestampMixin):
    """A logged-in session. Stores a token HASH, never the token itself, so a
    database read cannot be replayed as a valid session."""

    __tablename__ = "auth_sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    user_agent: Mapped[str | None] = mapped_column(String(255), nullable=True)

    user: Mapped[User] = relationship(back_populates="auth_sessions")


class OtpCode(Base, TimestampMixin):
    """A one-time login code for an EXISTING user. Only the HMAC hash is
    stored, same rule as passwords/tokens - a database read alone can never
    be replayed as a valid code. `created_at` (from TimestampMixin) doubles
    as "when was this last sent", for the resend cooldown."""

    __tablename__ = "otp_codes"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    code_hash: Mapped[str] = mapped_column(String(64))
    purpose: Mapped[str] = mapped_column(String(20), default="login")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class PasswordResetToken(Base, TimestampMixin):
    """A single-use, expiring password-reset link. Only a SHA-256 hash of the
    token is stored, same rule as OtpCode/AuthSession - a database read alone
    can never be replayed as a valid reset link."""

    __tablename__ = "password_reset_tokens"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class CounsellorAssignment(Base, TimestampMixin):
    """Which counsellor may access which victim's data - the real
    authorization relationship the counsellor dashboard's victim list is
    scoped by. Created only by an admin, never self-service. Deactivating an
    assignment (rather than deleting it) keeps who-had-access-when auditable."""

    __tablename__ = "counsellor_assignments"
    __table_args__ = (
        UniqueConstraint("counsellor_user_id", "victim_aura_id", name="uq_counsellor_victim"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    counsellor_user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    victim_aura_id: Mapped[str] = mapped_column(String(40), index=True)
    assigned_by_user_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class GuardianVictimLink(Base, TimestampMixin):
    """Which guardian may see which victim's summary data - admin-created,
    same pattern as CounsellorAssignment. A guardian sees a strictly smaller
    slice of data than a counsellor (no raw transcripts/facial data), enforced
    at the endpoint layer, not by this table alone."""

    __tablename__ = "guardian_victim_links"
    __table_args__ = (
        UniqueConstraint("guardian_user_id", "victim_aura_id", name="uq_guardian_victim"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    guardian_user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    victim_aura_id: Mapped[str] = mapped_column(String(40), index=True)
    assigned_by_user_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    active: Mapped[bool] = mapped_column(Boolean, default=True)


# --- Consent ---------------------------------------------------------------


class Consent(Base, TimestampMixin):
    """One consent grant per (aura_id, data_type). Withdrawal sets
    withdrawn_at rather than deleting, so the consent HISTORY is auditable -
    but processing checks `granted`, so withdrawal takes effect immediately."""

    __tablename__ = "consents"
    __table_args__ = (UniqueConstraint("aura_id", "data_type", name="uq_consent_scope"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    aura_id: Mapped[str] = mapped_column(String(40), index=True)
    data_type: Mapped[str] = mapped_column(String(40))
    purpose: Mapped[str] = mapped_column(String(255))
    granted: Mapped[bool] = mapped_column(Boolean, default=False)
    granted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    withdrawn_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


# --- Safety planning ---------------------------------------------------------
#
# Both tables are aura_id-scoped and per-user from day one, unlike the
# separate twin_store.py SQLite store (a known, pre-existing, single-shared
# prototype limitation flagged elsewhere in this codebase). Nothing here is
# ever auto-shared or auto-dialled - see api/safety_plan.py.


class TrustedContact(Base, TimestampMixin):
    """A person the user has chosen to list as someone they can reach. Purely
    informational - AURA never contacts this person itself; it only ever
    displays what the user entered back to the user."""

    __tablename__ = "trusted_contacts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    aura_id: Mapped[str] = mapped_column(String(40), index=True)
    name: Mapped[str] = mapped_column(String(120))
    relationship_label: Mapped[str | None] = mapped_column(String(60), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(32), nullable=True)
    email: Mapped[str | None] = mapped_column(String(320), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)


class SafetyPlan(Base, TimestampMixin):
    """One editable safety plan per person, in the standard trauma-informed
    safety-planning shape (warning signs / coping things / who to contact /
    professional support). Edited by the user at any time; never generated,
    auto-filled or shared without the user doing so explicitly."""

    __tablename__ = "safety_plans"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    aura_id: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    warning_signs: Mapped[dict] = mapped_column(JSON, default=list)
    coping_things: Mapped[dict] = mapped_column(JSON, default=list)
    contact_ids: Mapped[dict] = mapped_column(JSON, default=list)  # TrustedContact.id list
    professional_contact: Mapped[str | None] = mapped_column(Text, nullable=True)


class InterventionOutcome(Base, TimestampMixin):
    """Did a suggested coping action actually help THIS person, in THIS kind
    of situation. The personalization signal for future recommendations -
    never inferred, only recorded when the user answers "did that help?"."""

    __tablename__ = "intervention_outcomes"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    aura_id: Mapped[str] = mapped_column(String(40), index=True)
    situation: Mapped[str | None] = mapped_column(String(60), nullable=True)
    intervention_category: Mapped[str] = mapped_column(String(30))  # calm|reset|solve|restore|connect|reflect
    intervention_type: Mapped[str] = mapped_column(String(40))
    # better | slightly_better | same | worse
    result: Mapped[str] = mapped_column(String(20))


class FollowUp(Base, TimestampMixin):
    """A self-scheduled, in-app-only reminder ("check in about sleep
    tomorrow"). No push/SMS delivery exists in this codebase - surfaced as a
    banner on next visit, never dispatched externally."""

    __tablename__ = "follow_ups"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    aura_id: Mapped[str] = mapped_column(String(40), index=True)
    topic: Mapped[str] = mapped_column(String(120))
    scheduled_for: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    # pending | done | skipped
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)


# --- Analysis --------------------------------------------------------------


class AnalysisSession(Base, TimestampMixin):
    """The central entity every signal from one sitting attaches to, so the
    frontend can retrieve a complete analysis with one id."""

    __tablename__ = "analysis_sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    aura_id: Mapped[str] = mapped_column(String(40), index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    ended_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # processing | completed | insufficient_data | low_confidence | failed
    status: Mapped[str] = mapped_column(String(24), default="processing", index=True)
    status_reason: Mapped[str | None] = mapped_column(String(255), nullable=True)
    modalities: Mapped[dict] = mapped_column(JSON, default=list)

    emotion_records: Mapped[list["EmotionAnalysis"]] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )
    voice_records: Mapped[list["VoiceAnalysis"]] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )
    transcripts: Mapped[list["Transcript"]] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )
    sentiments: Mapped[list["SentimentAnalysis"]] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )


class EmotionAnalysis(Base, TimestampMixin):
    """Structured output of the MediaPipe/OpenCV/DeepFace pipeline.
    Probabilities come from the models - never from an LLM."""

    __tablename__ = "emotion_analysis"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    session_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("analysis_sessions.id", ondelete="CASCADE"), index=True
    )
    aura_id: Mapped[str] = mapped_column(String(40), index=True)
    dominant_emotion: Mapped[str | None] = mapped_column(String(20), nullable=True)
    probabilities: Mapped[dict] = mapped_column(JSON, default=dict)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    reliability: Mapped[float | None] = mapped_column(Float, nullable=True)
    quality_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    session: Mapped[AnalysisSession] = relationship(back_populates="emotion_records")


class VoiceAnalysis(Base, TimestampMixin):
    """Acoustic features only - no audio is retained."""

    __tablename__ = "voice_analysis"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    session_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("analysis_sessions.id", ondelete="CASCADE"), index=True
    )
    aura_id: Mapped[str] = mapped_column(String(40), index=True)
    pitch_mean: Mapped[float | None] = mapped_column(Float, nullable=True)
    pitch_variability: Mapped[float | None] = mapped_column(Float, nullable=True)
    speech_rate: Mapped[float | None] = mapped_column(Float, nullable=True)
    pause_ratio: Mapped[float | None] = mapped_column(Float, nullable=True)
    energy_mean: Mapped[float | None] = mapped_column(Float, nullable=True)
    voice_activity: Mapped[float | None] = mapped_column(Float, nullable=True)
    dominant_emotion: Mapped[str | None] = mapped_column(String(20), nullable=True)
    probabilities: Mapped[dict] = mapped_column(JSON, default=dict)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    audio_quality: Mapped[float | None] = mapped_column(Float, nullable=True)

    session: Mapped[AnalysisSession] = relationship(back_populates="voice_records")


class Transcript(Base, TimestampMixin):
    """Speech-to-text output. Low-confidence spans are marked 'unclear' upstream and
    are never replaced with guessed words."""

    __tablename__ = "transcripts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    session_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("analysis_sessions.id", ondelete="CASCADE"), index=True
    )
    aura_id: Mapped[str] = mapped_column(String(40), index=True)
    text: Mapped[str | None] = mapped_column(Text, nullable=True)
    display_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    language: Mapped[str | None] = mapped_column(String(10), nullable=True)
    language_confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    segment_confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    segments: Mapped[dict] = mapped_column(JSON, default=list)
    uncertain_segments: Mapped[dict] = mapped_column(JSON, default=list)

    session: Mapped[AnalysisSession] = relationship(back_populates="transcripts")


class SentimentAnalysis(Base, TimestampMixin):
    __tablename__ = "sentiment_analysis"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    session_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("analysis_sessions.id", ondelete="CASCADE"), index=True
    )
    aura_id: Mapped[str] = mapped_column(String(40), index=True)
    dominant: Mapped[str | None] = mapped_column(String(20), nullable=True)
    positive: Mapped[float | None] = mapped_column(Float, nullable=True)
    neutral: Mapped[float | None] = mapped_column(Float, nullable=True)
    negative: Mapped[float | None] = mapped_column(Float, nullable=True)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    themes: Mapped[dict] = mapped_column(JSON, default=list)

    session: Mapped[AnalysisSession] = relationship(back_populates="sentiments")


# --- Well-being ------------------------------------------------------------


class BaselineSignal(Base, TimestampMixin):
    __tablename__ = "baseline_signals"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    aura_id: Mapped[str] = mapped_column(String(40), index=True)
    answers: Mapped[dict] = mapped_column(JSON, default=dict)
    source: Mapped[str] = mapped_column(String(20), default="questionnaire")


class EngagementSignal(Base, TimestampMixin):
    """Check-in responses and engagement events."""

    __tablename__ = "engagement_signals"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    aura_id: Mapped[str] = mapped_column(String(40), index=True)
    values: Mapped[dict] = mapped_column(JSON, default=dict)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    skipped: Mapped[bool] = mapped_column(Boolean, default=False)
    kind: Mapped[str] = mapped_column(String(20), default="checkin")


class DigitalTwinSnapshot(Base, TimestampMixin):
    """A point-in-time twin, so historical states are inspectable rather than
    only ever recomputed from scratch."""

    __tablename__ = "digital_twin"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    aura_id: Mapped[str] = mapped_column(String(40), index=True)
    baseline: Mapped[dict] = mapped_column(JSON, default=dict)
    current_state: Mapped[dict] = mapped_column(JSON, default=dict)
    deviation: Mapped[dict] = mapped_column(JSON, default=dict)
    trend: Mapped[dict] = mapped_column(JSON, default=dict)
    engagement: Mapped[dict] = mapped_column(JSON, default=dict)
    baseline_confidence: Mapped[float] = mapped_column(Float, default=0.0)
    status: Mapped[str] = mapped_column(String(24), default="building")


class RiskAssessment(Base, TimestampMixin):
    __tablename__ = "risk_assessments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    aura_id: Mapped[str] = mapped_column(String(40), index=True)
    session_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    distress_signal: Mapped[float | None] = mapped_column(Float, nullable=True)
    band: Mapped[str | None] = mapped_column(String(10), nullable=True)
    status: Mapped[str] = mapped_column(String(24), default="insufficient_data")
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    components: Mapped[dict] = mapped_column(JSON, default=dict)
    contributing_factors: Mapped[dict] = mapped_column(JSON, default=list)
    data_quality: Mapped[dict] = mapped_column(JSON, default=dict)
    human_review_required: Mapped[bool] = mapped_column(Boolean, default=False)


class Alert(Base, TimestampMixin):
    """A review alert. Raised INSIDE the dashboard only - creating an alert
    never notifies police, emergency services or family."""

    __tablename__ = "alerts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    aura_id: Mapped[str] = mapped_column(String(40), index=True)
    risk_assessment_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    band: Mapped[str] = mapped_column(String(10))
    status: Mapped[str] = mapped_column(String(24), default="pending_review", index=True)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)


class HumanReview(Base, TimestampMixin):
    """A decision made by an accountable person. actor_role is mandatory."""

    __tablename__ = "human_reviews"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    aura_id: Mapped[str] = mapped_column(String(40), index=True)
    alert_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    action: Mapped[str] = mapped_column(String(40))
    actor_role: Mapped[str] = mapped_column(String(20))
    actor_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    decided_by_ai: Mapped[bool] = mapped_column(Boolean, default=False)


class Intervention(Base, TimestampMixin):
    __tablename__ = "interventions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    aura_id: Mapped[str] = mapped_column(String(40), index=True)
    pathway: Mapped[str] = mapped_column(String(80))
    # recommended | approved | rejected | in_progress | completed
    status: Mapped[str] = mapped_column(String(24), default="recommended", index=True)
    recommended_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    decided_by: Mapped[str | None] = mapped_column(String(80), nullable=True)
    decided_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class RecoveryRecord(Base, TimestampMixin):
    __tablename__ = "recovery_records"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    aura_id: Mapped[str] = mapped_column(String(40), index=True)
    intervention_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    phase: Mapped[str] = mapped_column(String(24))  # before | follow_up | recovered
    distress_signal: Mapped[float | None] = mapped_column(Float, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)


class AuditLog(Base):
    """Append-only. No update or delete path exists in the service layer.

    Deliberately NOT given a foreign key to users: audit entries must survive
    account deletion, otherwise deleting an account would erase the record of
    who accessed that account's data.
    """

    __tablename__ = "audit_logs"
    __table_args__ = (Index("ix_audit_ts_actor", "timestamp", "actor_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    timestamp: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, index=True
    )
    actor_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    actor_role: Mapped[str] = mapped_column(String(20))
    action: Mapped[str] = mapped_column(String(40), index=True)
    resource: Mapped[str | None] = mapped_column(String(80), nullable=True)
    resource_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    ip_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)


# --- Calls & SOS -------------------------------------------------------
#
# SCHEMA READY, RUNTIME NOT YET CUT OVER: the running call system
# (backend/app/ivrs_store.py, backend/app/api/ivrs.py) and SOS system
# (backend/app/sos_store.py, backend/app/api/sos.py) currently persist to
# their own separate SQLite files, not these tables - that pre-existing
# split (flagged repeatedly elsewhere in this codebase, e.g. twin_store.py)
# is what these tables are defined ahead of, for when that runtime cutover
# happens. Defining them now, in the one shared schema, means the target
# shape already exists and is covered by a real Alembic migration.


class CallSession(Base, TimestampMixin):
    """One AURA call - counsellor-generated or victim-self-initiated.
    `transcript` is the settled, complete turn list once the call ends;
    CallEvent below is the finer-grained real-time log of everything that
    happened during it."""

    __tablename__ = "call_sessions"
    __table_args__ = (Index("ix_call_sessions_victim_ts", "victim_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    victim_id: Mapped[str] = mapped_column(String(40), index=True)  # aura_id
    counsellor_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    reason: Mapped[str] = mapped_column(String(40))
    message: Mapped[str] = mapped_column(Text)
    # pending | ringing | answered | declined | in_progress | completed | failed
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    answered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    transcript: Mapped[dict] = mapped_column(JSON, default=list)
    language: Mapped[str | None] = mapped_column(String(10), nullable=True)


class CallEvent(Base):
    """Append-only real-time event log for one call - state changes and
    turns, in order, as they actually happened."""

    __tablename__ = "call_events"
    __table_args__ = (Index("ix_call_events_call_ts", "call_id", "at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    call_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("call_sessions.id", ondelete="CASCADE"), index=True
    )
    event_type: Mapped[str] = mapped_column(String(30))  # state | turn_user | turn_aura
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)


class SosEvent(Base):
    """A real SOS trigger. Append-only, same rule as AuditLog - location is
    stored only when the browser actually granted it for that specific
    click, never guessed or defaulted."""

    __tablename__ = "sos_events"
    __table_args__ = (Index("ix_sos_events_victim_ts", "victim_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    victim_id: Mapped[str] = mapped_column(String(40), index=True)  # aura_id
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)
    latitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    longitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    page: Mapped[str | None] = mapped_column(String(64), nullable=True)
