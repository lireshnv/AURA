"""Deterministic crisis-safety layer for the AURA Companion.

WHY THIS EXISTS
---------------
The system prompt tells the model to surface crisis support when someone is in
danger. That is necessary but not sufficient: a prompt is a request, not a
guarantee. Models drift, get talked out of instructions, or miss a disclosure
buried in a long message.

So crisis detection also runs deterministically, outside the model. When a
possible crisis indicator is present, the API attaches a resource block to the
response regardless of what the model chose to say. The model cannot suppress
it, because the model is not consulted about it.

DESIGN CONSTRAINTS
------------------
* This is a SAFETY NET, not a classifier. It is intentionally biased toward
  false positives: showing a support banner to someone who did not need it is a
  minor annoyance, while missing a genuine disclosure is not.
* It never blocks, interrupts or replaces the conversation. The companion still
  responds normally; resources appear alongside.
* Matching is on word boundaries to avoid the classic substring failures
  ("therapist" containing "the rapist", "assist" containing "assi").
* It never logs the matched message text - only that a category fired.
"""
import logging
import re
from dataclasses import dataclass, field
from typing import Dict, List

logger = logging.getLogger("aura.chat_safety")

# Phrases grouped by concern. Deliberately phrase-level rather than single
# emotive words: "hopeless" alone is common in ordinary difficult conversation
# and would fire constantly, which trains people to ignore the banner.
# Negation fragments must cover BOTH the contracted and expanded forms.
# This was a real miss found in live testing: "I don't want to live" matched
# while "I do not want to live" did not. Speech-to-text in particular tends to
# expand contractions, so the formal phrasing is not an edge case.
_DONT = r"(?:don'?t|do not|dont)"
_CANT = r"(?:can'?t|cannot|can not|cant)"
_IM = r"(?:i'?m|i am)"
_HES = r"(?:he'?s|he is)"
_SHES = r"(?:she'?s|she is)"
_THEYRE = r"(?:they'?re|they are)"

CRISIS_PATTERNS: Dict[str, List[str]] = {
    "self_harm": [
        r"\bkill(?:ing)? (?:myself|me)\b",
        r"\bend(?:ing)? (?:my|it all|my own) life\b",
        r"\btake (?:my own life|my life)\b",
        r"\bwant(?:ing)? to die\b",
        rf"\b{_DONT} want to (?:be here|live|wake up|exist|go on)\b",
        rf"\b{_DONT} (?:want to be alive|wanna live)\b",
        r"\bbetter off (?:dead|without me)\b",
        r"\bsuicid(?:e|al)\b",
        r"\bhurt(?:ing)? myself\b",
        r"\bharm(?:ing)? myself\b",
        r"\bself[- ]harm\b",
        r"\bcut(?:ting)? myself\b",
        r"\bno reason to (?:live|go on|be here)\b",
        r"\bnothing to live for\b",
        rf"\b{_CANT} (?:go on|do this anymore|take (?:it|this) anymore)\b",
        r"\bwish i (?:was|were) dead\b",
        r"\bwant it (?:all )?to (?:end|stop)\b",
    ],
    "immediate_danger": [
        # "coming" needs an immediacy qualifier. Bare "he is coming" matched
        # "He is coming to the hearing next week" - ordinary phrasing for
        # someone in a legal case, which is exactly this product's users. A
        # banner that fires on routine sentences gets ignored when it matters.
        rf"\b{_HES} (?:right )?(?:here|outside|breaking in)\b",
        rf"\b{_SHES} (?:right )?(?:here|outside|breaking in)\b",
        rf"\b{_THEYRE} (?:right )?(?:here|outside|breaking in)\b",
        rf"\b(?:{_HES}|{_SHES}|{_THEYRE}) coming (?:here|now|for me|to get me|after me)\b",
        r"\bcoming (?:to get|after) me (?:now|right now)?\b",
        r"\bgoing to (?:kill|hurt|attack|rape) me\b",
        rf"\b{_IM} (?:not safe|in danger|scared for my life)\b",
        r"\bhelp me now\b",
        r"\bbeing (?:attacked|followed|threatened|chased)\b",
        r"\bhas a (?:knife|gun|weapon)\b",
        r"\bcall the police\b",
    ],
    "harm_to_others": [
        r"\bkill(?:ing)? (?:him|her|them)\b",
        r"\bhurt (?:him|her|them) badly\b",
        r"\bmake (?:him|her|them) pay\b",
    ],
    "medical_emergency": [
        r"\boverdos(?:e|ed|ing)\b",
        r"\btook (?:too many|all the|a lot of) pills\b",
        r"\bbleeding (?:a lot|badly|heavily)\b",
        rf"\b{_CANT} breathe\b",
    ],
    # Distinct from "immediate_danger": that category is written for someone
    # physically present or approaching right now ("he is outside"). This one
    # catches an ongoing abusive relationship disclosed in active voice - "my
    # husband is threatening me" - which the immediate_danger patterns miss
    # (they only matched the passive "being threatened"). Routed to India's
    # women-safety helplines rather than police-only, since that is the more
    # appropriate first resource for this category of disclosure.
    "domestic_violence": [
        r"\bthreaten(?:ing|ed)? me\b",
        r"\b(?:husband|wife|partner|boyfriend|girlfriend|in-laws?) (?:is|are|keeps?|has been) (?:threatening|hitting|beating|abusing|assaulting) me\b",
        r"\b(?:he|she|they|husband|wife|partner|boyfriend|girlfriend|in-laws?) (?:hits?|beats?|hit|beat|slapped|punched) me\b",
        r"\bdomestic violence\b",
        r"\bdowry\b",
        r"\bmarital (?:abuse|rape)\b",
    ],
}

_COMPILED = {
    category: [re.compile(p, re.IGNORECASE) for p in patterns]
    for category, patterns in CRISIS_PATTERNS.items()
}

# AURA is deployed for Indian users, so these are AURA's own hard defaults
# (not per-deployment config) - the same posture the rest of the platform
# takes: only widely-published, unambiguous NATIONAL numbers that work the
# same way everywhere in India, never a state-specific helpline, police
# station or hospital name the app cannot verify for the user's actual
# location. State-specific resources are the model's job (via its web-search
# tool, only after asking which state) - never this deterministic layer's.
INDIA_EMERGENCY = {
    "label": "112 — India Emergency Response Support System",
    "detail": "National single emergency number (police/fire/medical). Call or use the 112 India app.",
    "priority": "immediate",
}
INDIA_POLICE = {
    "label": "100 — Police",
    "detail": "Where your local police still list 100 separately from 112.",
    "priority": "immediate",
}
INDIA_WOMEN_HELPLINE = {
    "label": "181 — Women Helpline",
    "detail": "National helpline for women facing abuse or violence, run by the Ministry of Women & Child Development.",
    "priority": "high",
}
INDIA_WOMEN_POLICE_HELPLINE = {
    "label": "1091 — Women Police Helpline",
    "detail": "Where active in your state, for police assistance specifically for women's safety.",
    "priority": "high",
}
INDIA_CHILD_HELPLINE = {
    "label": "1098 — Child Helpline",
    "detail": "National 24/7 helpline for a child in danger or in need of care and protection.",
    "priority": "high",
}
TRUSTED_PERSON = {
    "label": "A person you trust",
    "detail": "Someone who can physically be with you right now.",
    "priority": "high",
}
AURA_COUNSELLOR = {
    "label": "Your AURA counsellor",
    "detail": "You can request human support from the Risk & Trend page at any time.",
    "priority": "high",
}

# Resources shown per triggered category. A message can trigger more than one
# category; check_message() merges and de-duplicates by label.
CATEGORY_RESOURCES: Dict[str, List[Dict]] = {
    "self_harm": [INDIA_EMERGENCY, TRUSTED_PERSON, AURA_COUNSELLOR],
    "immediate_danger": [INDIA_EMERGENCY, INDIA_POLICE, TRUSTED_PERSON],
    "domestic_violence": [INDIA_WOMEN_HELPLINE, INDIA_WOMEN_POLICE_HELPLINE, INDIA_EMERGENCY, AURA_COUNSELLOR],
    "harm_to_others": [TRUSTED_PERSON, AURA_COUNSELLOR],
    "medical_emergency": [INDIA_EMERGENCY],
}

CATEGORY_MESSAGE = {
    "self_harm": (
        "What you've shared sounds really heavy, and I'm glad you told me. "
        "I want to make sure you also have support from someone who can be "
        "there with you."
    ),
    "immediate_danger": (
        "Your safety matters right now. If you are in danger, please contact "
        "emergency services — they can reach you in a way I cannot."
    ),
    "domestic_violence": (
        "I'm really sorry you're going through this. If you are in immediate "
        "danger right now, please contact 112. If it's safe to talk, there are "
        "women's safety services in India that can help — you don't have to "
        "handle this alone."
    ),
    "harm_to_others": (
        "That sounds like a lot of pain to be carrying. Please consider speaking "
        "with someone who can support you through it."
    ),
    "medical_emergency": (
        "This sounds like it may need urgent medical attention. Please contact "
        "emergency services straight away."
    ),
}


@dataclass
class SafetyCheck:
    triggered: bool = False
    categories: List[str] = field(default_factory=list)
    message: str = ""
    resources: List[Dict] = field(default_factory=list)
    # Highest severity found, for UI prominence.
    severity: str = "none"          # none | elevated | urgent


def check_message(text: str) -> SafetyCheck:
    """Scans one user message for crisis indicators.

    Runs on the USER's message, not the model's reply: the goal is to catch the
    disclosure itself, so the banner appears even if the model's answer is
    inadequate.
    """
    result = SafetyCheck()
    if not text or not text.strip():
        return result

    for category, patterns in _COMPILED.items():
        if any(p.search(text) for p in patterns):
            result.categories.append(category)

    if not result.categories:
        return result

    result.triggered = True
    urgent = {"self_harm", "immediate_danger", "medical_emergency"}
    result.severity = "urgent" if urgent & set(result.categories) else "elevated"

    # Message priority: the most safety-critical category present, not just
    # whichever pattern happened to match first in the dict.
    priority_order = ["immediate_danger", "medical_emergency", "self_harm", "domestic_violence", "harm_to_others"]
    lead_category = next((c for c in priority_order if c in result.categories), result.categories[0])
    result.message = CATEGORY_MESSAGE.get(lead_category, CATEGORY_MESSAGE["self_harm"])

    # Merge resources across every triggered category, de-duplicated by label,
    # ordered by priority so "immediate" always sorts first.
    seen = set()
    merged: List[Dict] = []
    for category in result.categories:
        for resource in CATEGORY_RESOURCES.get(category, []):
            if resource["label"] in seen:
                continue
            seen.add(resource["label"])
            merged.append(resource)
    merged.sort(key=lambda r: 0 if r["priority"] == "immediate" else 1)
    result.resources = merged

    # Log that a category fired, never the message content itself.
    logger.info("Crisis safety layer triggered: categories=%s", result.categories)
    return result
