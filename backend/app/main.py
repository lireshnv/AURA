import logging
import os
import time
from dataclasses import asdict
from datetime import datetime, timezone
from typing import Optional

# No logging was ever configured app-wide: every module's `logger.info(...)`
# call (including the new [DEV AUTH] tracing in auth_routes.py) was silently
# dropped by Python's handler-of-last-resort, which only surfaces WARNING
# and above. This makes INFO visible in the console - development-only
# content is still separately gated by settings.is_production at the call
# site, this just controls whether INFO-level messages are shown AT ALL.
if os.environ.get("AURA_ENV", "development").lower() != "production":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware

from . import (
    audit_store,
    aura_api,
    config,
    database,
    history_store,
    ivrs_store,
    risk_api,
    sos_store,
    speech_to_text,
    text_emotion,
    twin_api,
    twin_store,
    voice_emotion,
    voice_realtime,
    voice_service,
    voice_signal,
)
from .distress_engine import build_report
from .distress_signal import FACTOR_WEIGHTS, compute_signal, detect_themes
from .multimodal_fusion import ModalityInput, fuse_modalities, fused_sentiment
from .emotion_engine import analyze_emotion, warm_up
from .face_preprocessing import (
    normalize_lighting,
    preprocess_frame,
    quality_label,
    quality_score,
    visibility_score,
)
from .facial_features import align_face, extract_geometry
from .fusion import (
    emotion_evidence,
    expression_intensity,
    explain,
    fuse,
    geometry_delta,
    landmark_support,
    pose_trust,
    reaction_label,
    region_motion,
    region_signals,
)
from .reliability import compute_reliability, reliability_label, signal_agreement
from .schemas import (
    AnalyzeResponse,
    DebugInfo,
    DistressSignalRequest,
    EmotionResult,
    EmotionScores,
    FacialEvidence,
    MultimodalRequest,
    QualityInfo,
    ReactionInfo,
    SaveSessionRequest,
    SentimentResult,
    SentimentScores,
    SessionAnalyzeRequest,
    SessionReportRequest,
    TextEmotionRequest,
    TranscriptAnalysisRequest,
)
from .reasoning import generate_explanation
from .sentiment import compute_sentiment
from .smoothing import store as session_store
from .api import auth_routes, chat, ivrs, patterns, safety_plan, sos
from .core.config import settings
from .services import groq_text_analysis

logger = logging.getLogger("aura")

app = FastAPI(title="AURA Emotion Analysis API")

# CORS origins come from configuration, never a wildcard. In production a
# missing AURA_CORS_ORIGINS still yields the restrictive localhost default
# rather than opening the API to any origin.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Aura-Role"],
)


@app.middleware("http")
async def security_headers(request, call_next):
    """Baseline security headers on every response.

    HSTS is only sent in production: emitting it from a local HTTP dev server
    would pin the browser to HTTPS for localhost and break development.
    """
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "geolocation=(), payment=()"
    if settings.is_production:
        response.headers["Strict-Transport-Security"] = (
            "max-age=31536000; includeSubDomains"
        )
    return response


app.include_router(auth_routes.router)
app.include_router(chat.router)
app.include_router(ivrs.router)
app.include_router(sos.router)
app.include_router(aura_api.router)
app.include_router(twin_api.router)
app.include_router(risk_api.router)
app.include_router(safety_plan.router)
app.include_router(patterns.router)


@app.get("/api/system/status")
async def system_status():
    """Runtime configuration and an honest integration report.

    Surfaces which optional integrations are actually usable, so a missing
    key shows as 'not configured' rather than silently degrading.
    """
    return {
        "success": True,
        "environment": settings.env,
        "database_backend": database.backend_name(),
        "integrations": settings.integration_status(),
        "auth": {
            "enabled": True,
            "mfa_implemented": False,
            "mfa_ready": True,
            "note": "MFA columns exist on the user model; verification is not yet implemented.",
        },
    }


def _bootstrap_admin() -> None:
    """Creates the first real admin account from environment credentials, if
    none exists yet. This is the only way an admin account can come into
    being with no admin already logged in to provision one - self-registration
    always refuses non-victim roles (see auth_routes.register), so without
    this there would be no way to ever reach the admin dashboard at all.

    A no-op unless BOTH env vars are set, and a no-op once any admin exists -
    it never resets or overwrites a real admin's password on restart.
    """
    admin_email = os.environ.get("AURA_ADMIN_EMAIL", "").strip().lower()
    admin_password = os.environ.get("AURA_ADMIN_PASSWORD", "").strip()
    if not admin_email or not admin_password:
        return

    from .database import SessionLocal
    from .database.models import Profile, User
    from .security.auth import generate_aura_id, hash_password, password_problems

    db = SessionLocal()
    try:
        if db.query(User).filter(User.role == "admin").first():
            return
        problems = password_problems(admin_password)
        if problems:
            logger.warning("AURA_ADMIN_PASSWORD does not meet policy (%s) - admin not created.", "; ".join(problems))
            return
        if db.query(User).filter(User.email == admin_email).first():
            logger.warning("AURA_ADMIN_EMAIL is already registered under a different role - admin not created.")
            return

        user = User(
            email=admin_email,
            password_hash=hash_password(admin_password),
            role="admin",
            aura_id=generate_aura_id(),
        )
        db.add(user)
        db.flush()
        db.add(Profile(user_id=user.id, display_name="Administrator"))
        db.commit()
        logger.info("Bootstrap admin account created for %s.", admin_email)
    finally:
        db.close()


@app.on_event("startup")
async def on_startup():
    # New SQLAlchemy core (users, consent, sessions, audit).
    database.init_db()
    _bootstrap_admin()
    # Existing stores are unchanged so current features keep working.
    history_store.init_db()
    twin_store.init_db()
    audit_store.init_db()
    ivrs_store.init_db()
    sos_store.init_db()
    # Load every model once at startup so no user request pays the load cost.
    # Each loader is independently guarded: a voice model failing to download
    # must not prevent the facial pipeline from starting.
    warm_up()
    from .services import sentiment_model

    for name, loader in (
        ("speech-to-text", speech_to_text.load_eagerly),
        ("voice emotion", voice_emotion.load_eagerly),
        ("text emotion", text_emotion.load_eagerly),
        ("sentiment", sentiment_model.load_eagerly),
    ):
        try:
            loader()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Eager load of %s failed (will retry on demand): %s", name, exc)


_REJECTION_MESSAGES = {
    "no_face": "No face detected. Please look towards the camera.",
    "multiple_faces": "Multiple faces detected. Please ensure only one face is visible.",
    "face_too_small": "Face is too small in the frame. Please move closer to the camera.",
    "too_dark": "Lighting is too dark. Please move to a brighter area.",
    "too_blurry": "Image is too blurry. Please hold steady and ensure the camera is focused.",
}


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


@app.get("/health")
async def health():
    return {"status": "ok", "service": "AURA Emotion Analysis API"}


@app.get("/api/version")
async def version():
    return {"version": "2.0.0"}


@app.post("/api/analyze-emotion", response_model=AnalyzeResponse)
async def analyze_emotion_endpoint(
    session_id: str = Form(...),
    frame: UploadFile = File(...),
):
    try:
        raw_bytes = await frame.read()
        if not raw_bytes:
            return AnalyzeResponse(
                success=False, timestamp=_timestamp(), face_detected=False,
                error="Received an empty frame upload.",
            )

        image = cv2.imdecode(np.frombuffer(raw_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            return AnalyzeResponse(
                success=False, timestamp=_timestamp(), face_detected=False,
                error="Uploaded file could not be decoded as an image.",
            )

        # 1. Quality gate + face crop. A frame that fails here is skipped
        #    outright: no emotion is invented for an unusable image, and
        #    analysis_used=False says so explicitly.
        pre = preprocess_frame(image)
        if not pre.ok:
            q = quality_score(pre.blur_score, pre.brightness) if pre.blur_score else 0.0
            return AnalyzeResponse(
                success=True,
                timestamp=_timestamp(),
                face_detected=pre.reason != "no_face",
                analysis_used=False,
                message=_REJECTION_MESSAGES.get(pre.reason, "Unable to process frame."),
                quality=QualityInfo(
                    overall=q, label="rejected", blur=round(pre.blur_score, 1),
                    brightness=round(pre.brightness, 1),
                    face_size=round(pre.face_area_ratio, 3), head_pose_ok=False,
                ),
            )

        # 2. Controlled lighting normalization (no-op unless the crop is
        #    actually badly exposed), then align on the eye line so
        #    mouth/eye/brow geometry is comparable frame to frame and DeepFace
        #    sees a canonical upright face.
        normalized_crop = normalize_lighting(pre.face_crop, pre.brightness)
        aligned_crop, _roll = align_face(normalized_crop)

        # 3. DeepFace - one signal, not the verdict.
        try:
            raw_scores = analyze_emotion(aligned_crop)
        except Exception as exc:  # noqa: BLE001 - DeepFace surfaces arbitrary backend errors
            logger.exception("DeepFace analysis failed")
            return AnalyzeResponse(
                success=False, timestamp=_timestamp(), face_detected=True,
                error=f"Emotion analysis failed: {exc}",
            )

        deepface_smoothed = session_store.update(session_id, raw_scores)
        deepface_dominant = max(deepface_smoothed, key=deepface_smoothed.get)

        q_score = quality_score(pre.blur_score, pre.brightness)
        v_score = visibility_score(pre.face_area_ratio)

        # 4. Per-region landmark geometry.
        geometry = extract_geometry(aligned_crop)

        support = None
        signals = None
        calibrating = False
        motion = {"overall": 0.0}
        yaw_ratio = pitch_ratio = roll_degrees = 0.0
        pitch_dev = 0.0
        landmark_trust = 0.0
        eye_detail: dict = {}

        if geometry is not None:
            yaw_ratio = geometry.yaw_ratio
            pitch_ratio = geometry.pitch_ratio
            roll_degrees = geometry.roll_degrees

            prev_geometry = session_store.swap_prev_geometry(session_id, geometry)
            baseline, calibrating = session_store.baseline_or_collect(session_id, geometry)

            if prev_geometry is not None:
                motion = region_motion(
                    {f: getattr(geometry, f) - prev_geometry[f] for f in prev_geometry}
                )

            if baseline is not None:
                # Pitch is a coarse 2D proxy, so it is only meaningful as a
                # deviation from this user's own calibrated head position -
                # tracked separately from the expression baseline.
                base_pitch = session_store.baseline_pitch(session_id)
                pitch_dev = pitch_ratio - base_pitch if base_pitch is not None else 0.0
                delta = geometry_delta(geometry, baseline)
                signals = region_signals(delta)
                support = landmark_support(delta, motion)

            landmark_trust = (q_score / 100) * pose_trust(yaw_ratio, pitch_dev)

            # Eye-region detail: blink transitions (relative to this user's own
            # baseline aperture) and iris gaze offset where refined landmarks
            # are available.
            blink = session_store.update_blink(
                session_id,
                geometry.eye_openness,
                baseline.get("eye_openness") if baseline else None,
            )
            eye_detail = {
                **blink,
                "left_openness": round(geometry.left_eye_openness, 4),
                "right_openness": round(geometry.right_eye_openness, 4),
                "asymmetry": round(geometry.eye_asymmetry, 4),
                "iris_available": geometry.iris_available,
                "gaze_offset": geometry.gaze_offset if geometry.iris_available else None,
            }

        # 5. Temporal: EMA of the evidence signal itself (never a vote for the
        #    previously-winning label, which self-reinforces).
        smoothed_support = session_store.update_support_ema(session_id, support)

        # 6. Fuse. THIS distribution is the final answer everything displays.
        fused_scores = fuse(
            deepface_smoothed, support, smoothed_support, q_score, yaw_ratio, pitch_dev
        )

        dominant = max(fused_scores, key=fused_scores.get)
        confidence = round(fused_scores[dominant], 1)

        previous_dominant = session_store.peek_last_dominant(session_id)
        temporal_stability = session_store.record_dominant(session_id, dominant)
        valid_observations = session_store.observation_count(session_id)

        agreement = signal_agreement(dominant, deepface_smoothed, support)
        overall_reliability = compute_reliability(
            q_score, landmark_trust, v_score, temporal_stability, agreement, valid_observations
        )

        intensity = expression_intensity(
            support or {k: 0.0 for k in config.EMOTION_KEYS},
            motion.get("overall", 0.0),
            deepface_smoothed.get("neutral", 0.0),
        )

        events = session_store.detect_events(session_id, signals)
        reasons = explain(
            dominant, signals, motion, deepface_smoothed, temporal_stability, valid_observations
        )

        # Report "uncertain" rather than naming an emotion the fused evidence
        # does not actually support.
        reported = dominant if confidence >= config.MIN_CONFIDENCE_FOR_LABEL else "uncertain"

        sentiment_dominant, sentiment_scores = compute_sentiment(fused_scores)

        return AnalyzeResponse(
            success=True,
            timestamp=_timestamp(),
            face_detected=True,
            analysis_used=True,
            emotion=EmotionResult(
                dominant=reported,
                confidence=confidence,
                reliability=overall_reliability,
                reliability_label=reliability_label(overall_reliability),
                expression_intensity=intensity,
                overall_reaction=reaction_label(intensity),
                scores=EmotionScores(**{k: round(v, 1) for k, v in fused_scores.items()}),
                session_dominant=session_store.session_dominant(session_id),
                recent_reaction=session_store.recent_reaction(session_id, dominant),
                reasons=reasons,
            ),
            sentiment=SentimentResult(
                dominant=sentiment_dominant, scores=SentimentScores(**sentiment_scores)
            ),
            facial_evidence=FacialEvidence(
                smile=round((signals or {}).get("smile", 0.0) * 100, 1),
                mouth=round(motion.get("mouth", 0.0), 1),
                eyes=round(motion.get("eyes", 0.0), 1),
                eyebrows=round(motion.get("brows", 0.0), 1),
                facial_motion=round(motion.get("overall", 0.0), 1),
            ),
            quality=QualityInfo(
                overall=q_score,
                label=quality_label(q_score),
                blur=round(pre.blur_score, 1),
                brightness=round(pre.brightness, 1),
                face_size=round(pre.face_area_ratio, 3),
                head_pose_ok=pose_trust(yaw_ratio, pitch_dev) > 0.5,
            ),
            reaction=ReactionInfo(
                previous=previous_dominant,
                current=dominant,
                transition=(
                    f"{previous_dominant}_to_{dominant}"
                    if previous_dominant not in (None, dominant)
                    else None
                ),
                intensity=intensity,
                events=events,
            ),
            debug=DebugInfo(
                deepface_dominant=deepface_dominant,
                deepface_scores=EmotionScores(
                    **{k: round(v, 1) for k, v in deepface_smoothed.items()}
                ),
                signals={k: round(v * 100, 1) for k, v in (signals or {}).items()},
                region_motion={k: round(v, 1) for k, v in motion.items()},
                temporal_support={k: round(v * 100, 1) for k, v in smoothed_support.items()},
                temporal_stability=temporal_stability,
                landmark_trust=round(landmark_trust, 3),
                calibrating=calibrating,
                yaw_ratio=round(yaw_ratio, 3),
                pitch_ratio=round(pitch_ratio, 3),
                roll_degrees=round(roll_degrees, 1),
                valid_observations=valid_observations,
                eyes=eye_detail,
            ),
        )
    except Exception as exc:  # noqa: BLE001 - one bad frame must never take the server down
        logger.exception("Unhandled error in analyze-emotion")
        return AnalyzeResponse(
            success=False, timestamp=_timestamp(), face_detected=False,
            error=f"Unexpected server error: {exc}",
        )


@app.post("/api/session/report")
async def session_report(payload: SessionReportRequest):
    return build_report(
        [obs.model_dump() for obs in payload.observations],
        voice_observations=[v.model_dump() for v in payload.voice_observations],
        agreement_samples=payload.agreement_samples,
    )


# =========================================================================
# VOICE / SPEECH / TEXT
#
# Entirely separate from /api/analyze-emotion above, which is unchanged. The
# facial pipeline neither calls nor depends on anything below, so voice can be
# unavailable without affecting it.
# =========================================================================


@app.get("/api/voice/capabilities")
async def voice_capabilities():
    """What the voice stack can actually do here, so the UI can show honest
    'unavailable' states instead of empty panels."""
    return voice_service.capability_report()


@app.post("/api/voice/emotion")
async def voice_emotion_endpoint(
    audio: UploadFile = File(...),
    include_transcript: bool = Form(True),
    language: Optional[str] = Form(None),
):
    """Full voice pipeline for one audio window: quality gate, VAD, acoustic
    features, voice tone, and (by default) transcript + text emotion.

    Transcript is included here rather than forcing a second upload of the
    same audio to /api/voice/transcribe - at a ~1s cadence that would double
    the bytes on the wire and re-run VAD and decoding for no benefit.
    """
    try:
        raw = await audio.read()
        result = voice_service.analyze_audio_window(
            raw,
            want_transcript=include_transcript,
            want_voice_emotion=True,
            language=language or None,
        )
        payload = asdict(result)
        payload["timestamp"] = _timestamp()
        return payload
    except Exception as exc:  # noqa: BLE001 - one bad window must not kill the server
        logger.exception("Unhandled error in voice/emotion")
        return {"success": False, "timestamp": _timestamp(), "error": f"Voice analysis failed: {exc}"}


@app.post("/api/voice/frame")
async def voice_frame_endpoint(
    audio: UploadFile = File(...),
    session_id: str = Form(...),
    window_start: float = Form(0.0),
    window_end: float = Form(0.0),
    is_final: bool = Form(False),
    include_transcript: bool = Form(True),
    language: Optional[str] = Form(None),
):
    """One real-time voice window: STT and acoustic analysis in parallel.

    Runs in a worker thread so the two CPU-bound branches inside cannot block
    the event loop - without this, a Whisper pass would stall every other
    request in the process, including the face pipeline.

    Returns a validated VoiceAnalysisFrame. Validation failures are reported as
    an error frame rather than a 500, so one bad window degrades that window
    only and the client keeps streaming.
    """
    try:
        raw = await audio.read()
        frame = await run_in_threadpool(
            voice_realtime.analyze_frame,
            raw,
            session_id=session_id,
            window_start=window_start,
            window_end=window_end,
            language=language or None,
            is_final=is_final,
            want_transcript=include_transcript,
        )
        return frame.model_dump()
    except Exception as exc:  # noqa: BLE001 - one bad window must not kill the server
        logger.exception("Unhandled error in voice/frame")
        return {
            "window": {
                "session_id": session_id,
                "window_start": window_start,
                "window_end": window_end,
                "timestamp": int(time.time() * 1000),
                "duration": max(0.0, window_end - window_start),
            },
            "analysis_used": False,
            "speech_detected": False,
            "error": f"Voice analysis failed: {exc}",
        }


@app.post("/api/voice/session/reset")
async def voice_session_reset(session_id: str = Form(...)):
    """Drops a session's smoothing and baseline state.

    Called when a new recording starts so one session's vocal baseline cannot
    leak into the next - a different speaker would otherwise be measured
    against the previous person's voice.
    """
    voice_signal.reset_session(session_id)
    return {"success": True, "session_id": session_id}


@app.post("/api/voice/transcribe")
async def voice_transcribe_endpoint(
    audio: UploadFile = File(...),
    language: Optional[str] = Form(None),
):
    """Transcript only - no voice-tone model run."""
    try:
        raw = await audio.read()
        result = voice_service.analyze_audio_window(
            raw, want_transcript=True, want_voice_emotion=False, language=language or None
        )
        return {
            "success": result.success,
            "timestamp": _timestamp(),
            "speech_detected": result.speech_detected,
            "analysis_used": result.analysis_used,
            "message": result.message,
            "error": result.error,
            "quality": result.quality,
            **(
                {
                    "text": result.transcript.get("text", ""),
                    "language": result.transcript.get("language"),
                    "language_probability": result.transcript.get("language_probability"),
                    "segments": result.transcript.get("segments", []),
                    "quality_indicator": result.transcript.get("quality_indicator"),
                }
                if result.transcript
                else {"text": "", "language": None, "segments": []}
            ),
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("Unhandled error in voice/transcribe")
        return {"success": False, "timestamp": _timestamp(), "error": f"Transcription failed: {exc}"}


@app.post("/api/text/emotion")
async def text_emotion_endpoint(payload: TextEmotionRequest):
    """Emotion + sentiment of supplied text, independent of any audio."""
    try:
        result = text_emotion.analyze_text(payload.text, language=payload.language)
        return {
            "success": result.available,
            "timestamp": _timestamp(),
            "emotion": {
                "dominant": result.dominant,
                "scores": result.scores,
                "confidence": result.confidence,
            },
            "sentiment": {
                "dominant": result.sentiment_dominant,
                **result.sentiment_scores,
            },
            "language_supported": result.language_supported,
            "evidence": result.evidence,
            "error": result.error,
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("Unhandled error in text/emotion")
        return {"success": False, "timestamp": _timestamp(), "error": f"Text analysis failed: {exc}"}


@app.post("/api/text/groq-analysis")
async def groq_transcript_analysis_endpoint(payload: TranscriptAnalysisRequest):
    """Structured Groq read of one SETTLED transcript segment.

    Distinct from /api/text/emotion: that endpoint's local models remain the
    numeric sentiment/emotion fed into distress scoring. This endpoint is the
    qualitative layer - key concerns, themes, a supportive reply, practical
    suggestions - grounded only in the transcript actually sent. The caller
    must only send validated/stable (final-pass) transcript, never a partial.
    """
    try:
        result = await run_in_threadpool(groq_text_analysis.analyze_transcript, payload.transcript)
        return {"success": True, "timestamp": _timestamp(), **result}
    except Exception as exc:  # noqa: BLE001
        logger.exception("Unhandled error in text/groq-analysis")
        return {"success": False, "timestamp": _timestamp(), "error": f"Groq analysis failed: {exc}"}


@app.post("/api/distress/signal")
async def distress_signal_endpoint(payload: DistressSignalRequest):
    """Live 0-100 decision-support signal with named contributing factors.

    Explicitly a prototype signal, not a clinical measure. Every factor is a
    measured aggregate over the rolling window with a published weight, so the
    number can always be decomposed.
    """
    try:
        signal = compute_signal(
            emotion_window=payload.emotion_window,
            sentiment_window=payload.sentiment_window,
            voice_stress=payload.voice_stress,
            face_motion=payload.face_motion,
            reliability=payload.reliability,
        )
        return {
            "success": True,
            "timestamp": _timestamp(),
            "score": signal.score,
            "level": signal.level,
            "confidence": signal.confidence,
            "factors": signal.factors,
            "components": signal.components,
            "factor_weights": FACTOR_WEIGHTS,
            "insufficient_data": signal.insufficient_data,
            "disclaimer": signal.disclaimer,
            "themes": detect_themes(payload.transcript or ""),
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("Unhandled error in distress/signal")
        return {"success": False, "timestamp": _timestamp(), "error": str(exc)}


# --- History ---------------------------------------------------------------


@app.post("/api/history/session")
async def save_history_session(payload: SaveSessionRequest):
    """Stores one completed session (derived signals only, never raw media)."""
    record = payload.model_dump()
    record["created_at"] = _timestamp()
    session_id = history_store.save_session(record)
    if session_id is None:
        return {"success": False, "error": "Could not save session to history."}
    return {"success": True, "id": session_id}


@app.get("/api/history/sessions")
async def list_history_sessions(limit: int = 50):
    sessions = history_store.list_sessions(limit=limit)
    return {
        "success": True,
        "sessions": sessions,
        "trend": history_store.compute_trend(sessions),
        "count": len(sessions),
    }


@app.delete("/api/history/session/{session_id}")
async def delete_history_session(session_id: str):
    return {"success": history_store.delete_session(session_id)}


@app.delete("/api/history/sessions")
async def clear_history_sessions():
    """User-initiated clear of all stored history."""
    return {"success": True, "deleted": history_store.clear_all()}


@app.post("/api/session/analyze")
async def session_analyze_endpoint(payload: SessionAnalyzeRequest):
    """ONE-CLICK multimodal analysis.

    Fuses the current face / voice / text readings, then produces an
    explainable result: combined signal, per-modality breakdown, confidence,
    reliability, cross-modal agreement, a measurement-derived "why", detected
    inconsistencies, stated limitations, and a human-review recommendation.

    Every number originates in the CV / audio / NLP models. The explanation
    layer only interprets them - it never produces or adjusts a score.
    """
    try:
        inputs = {
            name: (
                ModalityInput(
                    scores=m.scores, confidence=m.confidence, quality=m.quality, available=True
                )
                if m is not None
                else None
            )
            for name, m in (
                ("face", payload.face),
                ("voice", payload.voice),
                ("text", payload.text),
            )
        }
        fusion = fuse_modalities(inputs)

        explanation = generate_explanation(
            overall_emotion=fusion.dominant,
            overall_confidence=fusion.confidence,
            overall_reliability=fusion.reliability,
            agreement=fusion.agreement if len(fusion.modalities_used) > 1 else None,
            face=payload.face_detail,
            voice=payload.voice_detail,
            text=payload.text_detail,
            trend=payload.trend.model_dump() if payload.trend else None,
            modalities_used=fusion.modalities_used,
        )

        return {
            "success": True,
            "timestamp": _timestamp(),
            "combined": {
                "dominant": fusion.dominant,
                "scores": fusion.scores,
                # "signal strength" of the winning class, not a probability
                # that the person feels this way.
                "signal": fusion.confidence,
                "confidence": fusion.confidence,
                "reliability": fusion.reliability,
            },
            "per_modality": {
                "face": (
                    {
                        "signal": payload.face.confidence,
                        "quality": payload.face.quality,
                        "scores": payload.face.scores,
                    }
                    if payload.face
                    else None
                ),
                "voice": (
                    {
                        "signal": payload.voice.confidence,
                        "quality": payload.voice.quality,
                        "scores": payload.voice.scores,
                    }
                    if payload.voice
                    else None
                ),
                "text": (
                    {
                        "signal": payload.text.confidence,
                        "quality": payload.text.quality,
                        "scores": payload.text.scores,
                    }
                    if payload.text
                    else None
                ),
            },
            "sentiment": fused_sentiment(fusion.scores),
            "agreement": {
                "score": fusion.agreement,
                "label": fusion.agreement_label,
                "disagreement": fusion.disagreement,
                "per_modality_dominant": fusion.per_modality_dominant,
            },
            "modalities_used": fusion.modalities_used,
            "effective_weights": fusion.effective_weights,
            "explanation": {
                "headline": explanation.headline,
                "reasons": explanation.reasons,
                "inconsistencies": explanation.inconsistencies,
                "limitations": explanation.limitations,
                "human_review_recommended": explanation.human_review_recommended,
                "human_review_reason": explanation.human_review_reason,
                "generated_by": explanation.generated_by,
            },
            "notes": fusion.notes,
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("Unhandled error in session/analyze")
        return {"success": False, "timestamp": _timestamp(), "error": f"Analysis failed: {exc}"}


@app.post("/api/multimodal/analyze")
async def multimodal_analyze_endpoint(payload: MultimodalRequest):
    """Fuses whichever of face/voice/text were supplied into one estimate.

    Stateless by design: the caller owns the session history and passes the
    current per-modality readings. That keeps this endpoint cheap and lets the
    frontend fuse on every tick without server-side session coupling.
    """
    try:
        inputs = {
            name: (
                ModalityInput(
                    scores=m.scores, confidence=m.confidence, quality=m.quality, available=True
                )
                if m is not None
                else None
            )
            for name, m in (
                ("face", payload.face),
                ("voice", payload.voice),
                ("text", payload.text),
            )
        }
        fusion = fuse_modalities(inputs)
        return {
            "success": True,
            "timestamp": _timestamp(),
            "emotion": {
                "dominant": fusion.dominant,
                "scores": fusion.scores,
                "confidence": fusion.confidence,
                "reliability": fusion.reliability,
            },
            "sentiment": fused_sentiment(fusion.scores),
            "agreement": {
                "score": fusion.agreement,
                "label": fusion.agreement_label,
                "disagreement": fusion.disagreement,
                "per_modality_dominant": fusion.per_modality_dominant,
            },
            "modalities_used": fusion.modalities_used,
            "effective_weights": fusion.effective_weights,
            "notes": fusion.notes,
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("Unhandled error in multimodal/analyze")
        return {"success": False, "timestamp": _timestamp(), "error": f"Fusion failed: {exc}"}
