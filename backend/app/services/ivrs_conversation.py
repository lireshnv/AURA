"""Conversation generation for the AURA IVRS call simulation.

Reuses the same Groq client/model as the AI Companion (`chatbot_service`)
rather than standing up a second client - Groq's job here is identical
(one conversational turn given history), only the system prompt and the
per-call history store differ.

Groq generates ONLY the reply text for a real thing the user actually said
(or the deterministic opening line below) - it never invents what the user
said, and the exact text it returns is what gets voiced, unedited, by
ElevenLabs TTS.
"""
from typing import Dict, List, Optional

from . import chatbot_service

CALL_REASONS: Dict[str, Dict[str, str]] = {
    "missed_checkin": {
        "label": "Missed check-in",
        "emoji": "❤️",
        "opening": "Hi, this is AURA. Your counsellor noticed you missed your check-in today. How are you feeling?",
    },
    "missed_water": {
        "label": "Missed water activity",
        "emoji": "💧",
        "opening": "Hi, this is AURA. Your counsellor noticed you missed your water activity today. Would you like to do that now?",
    },
    "missed_feeding": {
        "label": "Missed feeding activity",
        "emoji": "🐾",
        "opening": "Hi, this is AURA. Your counsellor noticed your companion hasn't been fed today. Would you like to do that now?",
    },
    "wellbeing_followup": {
        "label": "Well-being follow-up",
        "emoji": "🌱",
        "opening": "Hi, this is AURA, calling for a well-being follow-up your counsellor requested. Do you have a moment to talk?",
    },
    "counsellor_followup": {
        "label": "Counsellor follow-up",
        "emoji": "📋",
        "opening": "Hi, this is AURA. Your counsellor asked me to follow up with you. Is now an okay time to talk?",
    },
    "custom": {
        "label": "Custom supportive message",
        "emoji": "💬",
        "opening": "",  # always supplied by the counsellor for this reason - see opening_line()
    },
}


def opening_line(reason_key: str, custom_message: Optional[str] = None) -> str:
    """Deterministic, templated opening - not model-generated - so the exact
    wording matches what the call was actually placed for. For 'custom' this
    is the counsellor's own message, spoken verbatim - never altered."""
    if reason_key == "custom":
        return (custom_message or "").strip() or "Hi, this is AURA, calling with a message from your counsellor."
    reason = CALL_REASONS.get(reason_key, CALL_REASONS["counsellor_followup"])
    return reason["opening"]


def _system_prompt(reason_key: str, custom_message: Optional[str]) -> str:
    reason = CALL_REASONS.get(reason_key, CALL_REASONS["counsellor_followup"])
    reason_text = (custom_message or "").strip() if reason_key == "custom" else reason["label"]
    return (
        "You are AURA, speaking on a short wellness phone call placed on a "
        f"counsellor's behalf. The call reason: {reason_text}. "
        "Stay warm, brief, and natural, like a real short phone call - "
        "usually one or two short sentences per turn, never a long paragraph. "
        "Respond ONLY to what the person actually said; never invent things "
        "they did not say, and never claim an action was completed unless "
        "they told you they did it or agreed to it. "
        "If they agree to do something (like watering their plant, feeding "
        "their companion, or checking in), acknowledge it warmly and, if it "
        "fits naturally, ask if they'd like to do one more small thing "
        "before ending the call. "
        "If they decline or seem done, wrap up warmly and let the call end. "
        "You are not a clinician and do not diagnose; if they mention being "
        "in danger or in crisis, gently encourage them to contact emergency "
        "services or a trusted person, and mention their counsellor can be "
        "reached through AURA."
    )


def reply(reason_key: str, custom_reason: Optional[str], history: List[Dict], user_message: str):
    """One conversational turn. `history` is this call's real prior turns
    only (role/content dicts) - never fabricated or backfilled."""
    messages: List[Dict] = [{"role": "system", "content": _system_prompt(reason_key, custom_reason)}]
    messages.extend(history)
    messages.append({"role": "user", "content": user_message})

    try:
        client = chatbot_service.get_client()
    except RuntimeError as exc:
        return chatbot_service.ChatResult(
            reply=chatbot_service.USER_FACING_ERROR, status="unavailable", error_code=str(exc)
        )

    try:
        response = client.chat.completions.create(
            model=chatbot_service.MODEL,
            messages=messages,
            max_tokens=200,
            temperature=0.6,
        )
        text = response.choices[0].message.content or ""
        return chatbot_service.ChatResult(reply=text, status="success")
    except Exception as exc:  # noqa: BLE001
        return chatbot_service.ChatResult(
            reply=chatbot_service.USER_FACING_ERROR, status="error", error_code=type(exc).__name__
        )
