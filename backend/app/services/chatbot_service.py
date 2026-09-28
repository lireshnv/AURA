"""AURA Companion chatbot service.

Ported from the existing implementation in `moni/AURA_SIH-main/chatbot/agent.py`.
Preserved from the original:

  * Groq client and the same model (openai/gpt-oss-120b)
  * the DuckDuckGo `search_web` tool and the two-call tool-use flow
  * dynamic system-prompt loading from disk (so prompt edits apply live)
  * Groq Whisper transcription
  * the trauma-informed counselling approach and Markdown formatting

Changed for integration, and why:

  * The API key is read from the environment and never leaves the backend.
    The browser talks to AURA's FastAPI; only FastAPI talks to Groq.
  * Errors are mapped to safe user-facing messages. The original surfaced
    `str(e)` to the client, which can leak key fragments, model names and
    stack detail.
  * A deterministic crisis check runs alongside the model (see chat_safety).
    See SAFETY_NOTE below for the system-prompt change and its rationale.
"""
import json
import logging
import os
from dataclasses import dataclass, field
from typing import Dict, Iterator, List, Optional

logger = logging.getLogger("aura.chatbot")

try:
    from groq import Groq

    _GROQ_AVAILABLE = True
except ImportError:  # noqa: BLE001
    _GROQ_AVAILABLE = False

try:
    from duckduckgo_search import DDGS

    _SEARCH_AVAILABLE = True
except ImportError:  # noqa: BLE001
    _SEARCH_AVAILABLE = False


MODEL = os.environ.get("AURA_CHAT_MODEL", "openai/gpt-oss-120b")
TRANSCRIBE_MODEL = os.environ.get("AURA_TRANSCRIBE_MODEL", "whisper-large-v3")
TTS_MODEL = os.environ.get("AURA_TTS_MODEL", "canopylabs/orpheus-v1-english")
TTS_VOICE = os.environ.get("AURA_TTS_VOICE", "hannah")
MAX_TOKENS = int(os.environ.get("AURA_CHAT_MAX_TOKENS", "1024"))
REQUEST_TIMEOUT = float(os.environ.get("AURA_CHAT_TIMEOUT", "45"))
MAX_TTS_CHARS = 2000

PROMPT_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "prompts", "aura_companion.md")

USER_FACING_ERROR = "Sorry, I'm temporarily unavailable. Please try again."

SAFETY_NOTE = """
The original system prompt instructed the assistant to never refer users to
therapists, crisis hotlines or emergency numbers, and to present itself as a
'highly trained trauma counselor' that must 'never hand them off'.

That was changed. For a service used by abuse survivors, a rule that blocks
crisis referral is unsafe: if someone discloses suicidal intent or immediate
danger, the assistant must be able to point them to help that can physically
reach them. The change also aligns the companion with the safety posture the
rest of AURA already states - that it supports rather than replaces
professional care.

Everything else about the original prompt was kept: the empathetic tone, the
trauma-informed approach, no unsolicited problem-solving, avoidance of
triggering language, and Markdown formatting.
""".strip()


# --- Web search tool (unchanged from the original definition) --------------

WEB_SEARCH_TOOL = {
    "type": "function",
    "function": {
        "name": "search_web",
        "description": (
            "Searches the web for information using DuckDuckGo. Use this tool when "
            "the user asks for factual information, NGOs, legal rights, or anything "
            "that requires up-to-date knowledge from the internet."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query to look up on the internet.",
                }
            },
            "required": ["query"],
        },
    },
}


@dataclass
class ChatResult:
    reply: str = ""
    status: str = "success"          # success | unavailable | error
    used_web_search: bool = False
    search_queries: List[str] = field(default_factory=list)
    model: str = MODEL
    error_code: Optional[str] = None


def is_configured() -> bool:
    return _GROQ_AVAILABLE and bool(os.environ.get("GROQ_API_KEY", "").strip())


def capability_report() -> Dict:
    """Honest report of what the companion can currently do."""
    return {
        "groq_installed": _GROQ_AVAILABLE,
        "api_key_configured": bool(os.environ.get("GROQ_API_KEY", "").strip()),
        "web_search_available": _SEARCH_AVAILABLE,
        "model": MODEL,
        "transcription_model": TRANSCRIBE_MODEL,
        "tts_model": TTS_MODEL,
        "tts_available": is_configured(),
        "ready": is_configured(),
        "note": (
            "Set GROQ_API_KEY in the backend environment to enable the companion."
            if not is_configured()
            else "Companion is configured."
        ),
    }


def _get_client():
    """Builds a Groq client. Raises RuntimeError with no key material in it."""
    if not _GROQ_AVAILABLE:
        raise RuntimeError("groq_not_installed")
    api_key = os.environ.get("GROQ_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("api_key_missing")
    return Groq(api_key=api_key, timeout=REQUEST_TIMEOUT)


def get_client():
    """Public entry point for other services (e.g. groq_text_analysis) that
    need the same Groq client this module builds for chat, rather than each
    standing up its own client/key-handling."""
    return _get_client()


def _load_system_prompt() -> str:
    """Reads the prompt from disk on each call so edits apply without restart -
    behaviour preserved from the original implementation."""
    try:
        with open(PROMPT_PATH, "r", encoding="utf-8") as f:
            return f.read()
    except OSError:
        logger.exception("Could not read system prompt at %s", PROMPT_PATH)
        # A generic but safe fallback rather than proceeding with no guidance.
        return (
            "You are AURA, a supportive AI companion. Listen with empathy, do not "
            "claim to be a licensed clinician, and if someone is in danger or "
            "speaks about self-harm, encourage them to contact emergency services "
            "or a crisis line while staying present with them."
        )


def perform_web_search(query: str) -> str:
    """DuckDuckGo search. Returns a readable string, never raises."""
    if not _SEARCH_AVAILABLE:
        return "Web search is not available in this environment."
    try:
        results = DDGS().text(query, max_results=3)
        if not results:
            return "No relevant information found on the web."
        return "\n\n".join(
            f"Title: {r.get('title', '')}\nSnippet: {r.get('body', '')}\nURL: {r.get('href', '')}"
            for r in results
        )
    except Exception:  # noqa: BLE001 - search failure must not break the reply
        logger.exception("Web search failed")
        return "Web search is temporarily unavailable."


_LANGUAGE_NAMES = {
    "hi": "Hindi", "bn": "Bengali", "ta": "Tamil", "te": "Telugu", "mr": "Marathi",
    "gu": "Gujarati", "kn": "Kannada", "ml": "Malayalam", "pa": "Punjabi",
    "or": "Odia", "as": "Assamese", "ur": "Urdu", "en": "English",
}


def _language_instruction(language: Optional[str]) -> Optional[str]:
    """Turns the caller's selected language code into a system-prompt note.

    Absent or "auto"/"en" adds nothing - the base prompt already asks for
    clear Indian English by default. Never fabricates a language name for a
    code it doesn't recognise; it names the code as given rather than
    guessing what it stands for.
    """
    if not language or language.lower() in ("auto", "en", "en-in", "en-us"):
        return None
    name = _LANGUAGE_NAMES.get(language.lower(), language)
    return (
        f"The user has selected '{name}' as their preferred language. Reply "
        f"primarily in {name}, in natural conversational phrasing - keep official "
        f"helpline numbers and proper names in their standard form."
    )


VOICE_MODE_NOTE = (
    "The user is talking to you by voice right now, not reading text. Reply in "
    "1-3 short, natural spoken sentences - the way a person actually talks, not "
    "a written paragraph. Often one short sentence is enough. No Markdown, no "
    "bullet points, no lists - nothing that only makes sense written down. "
    "Natural short reactions ('Yeah.' 'Wait, what happened?' 'Okay, that makes "
    "sense.') are appropriate here in a way they wouldn't be in text. Only go "
    "longer if the user explicitly asks for detail or a list of resources."
)


def get_system_prompt(language: Optional[str] = None, voice_mode: bool = True) -> str:
    """Public accessor for Aura's exact personality prompt, so every realtime
    path (currently: Gemini Live) uses the SAME assembled prompt as the Groq
    companion rather than forking a second copy of it. Read fresh from disk
    each call (via _load_system_prompt), same as the Groq path, so prompt
    edits apply live everywhere at once."""
    system_prompt = _load_system_prompt()
    language_note = _language_instruction(language)
    if language_note:
        system_prompt = f"{system_prompt}\n\n## Language\n\n{language_note}"
    if voice_mode:
        system_prompt = f"{system_prompt}\n\n## Voice conversation\n\n{VOICE_MODE_NOTE}"
    return system_prompt


def _build_messages(
    message: str, history: List[Dict], language: Optional[str], voice_mode: bool
) -> List[Dict]:
    system_prompt = get_system_prompt(language, voice_mode)
    messages: List[Dict] = [{"role": "system", "content": system_prompt}]
    messages.extend(history)
    messages.append({"role": "user", "content": message})
    return messages


def _tool_kwargs(tool_choice: str) -> Dict:
    """The web-search tool arguments, or nothing at all when search isn't
    installed. Passing tools=None/tool_choice=None is not the same as leaving
    them out: the Groq client sends a literal null, which the API rejects."""
    if not _SEARCH_AVAILABLE:
        return {}
    return {"tools": [WEB_SEARCH_TOOL], "tool_choice": tool_choice}


def chat(
    message: str,
    history: Optional[List[Dict]] = None,
    language: Optional[str] = None,
    voice_mode: bool = False,
) -> ChatResult:
    """Sends one turn to Groq, handling the tool-call round trip.

    Mirrors the original two-call flow: first call may return tool calls; the
    tool output is appended and a second call produces the final reply.
    """
    history = history or []

    if not message or not message.strip():
        return ChatResult(reply="", status="error", error_code="empty_message")

    try:
        client = _get_client()
    except RuntimeError as exc:
        code = str(exc)
        logger.warning("Companion unavailable: %s", code)
        return ChatResult(reply=USER_FACING_ERROR, status="unavailable", error_code=code)

    messages = _build_messages(message, history, language, voice_mode)

    # Bounded tool-call loop rather than a fixed one-search-then-answer flow.
    # The India-context prompt actively encourages searching for state- or
    # law-specific answers, which makes it common for the model to want a
    # second, refined search after seeing the first result - and Groq
    # rejects a follow-up call that offers no `tools` if the model tries to
    # call one anyway ("Tool choice is none, but model called a tool"). A
    # hard cap keeps this from looping forever if the model never settles.
    MAX_TOOL_ROUNDS = 3
    used_web_search = False
    queries: List[str] = []

    try:
        for _round in range(MAX_TOOL_ROUNDS):
            response = client.chat.completions.create(
                model=MODEL,
                messages=messages,
                max_tokens=MAX_TOKENS,
                **_tool_kwargs("auto"),
            )
            response_message = response.choices[0].message
            tool_calls = getattr(response_message, "tool_calls", None)

            if not tool_calls:
                return ChatResult(
                    reply=response_message.content or "",
                    status="success",
                    used_web_search=used_web_search,
                    search_queries=queries,
                )

            messages.append(response_message)
            for tool_call in tool_calls:
                if tool_call.function.name != "search_web":
                    continue
                try:
                    args = json.loads(tool_call.function.arguments or "{}")
                except json.JSONDecodeError:
                    args = {}
                query = args.get("query", "")
                queries.append(query)
                used_web_search = True
                messages.append(
                    {
                        "tool_call_id": tool_call.id,
                        "role": "tool",
                        "name": "search_web",
                        "content": perform_web_search(query),
                    }
                )

        # Ran out of rounds without a final answer - ask once more with
        # tool_choice="none" so the model must answer with what it already has
        # rather than erroring on yet another tool call attempt.
        final = client.chat.completions.create(
            model=MODEL,
            messages=messages,
            max_tokens=MAX_TOKENS,
            **_tool_kwargs("none"),
        )
        return ChatResult(
            reply=final.choices[0].message.content or "",
            status="success",
            used_web_search=used_web_search,
            search_queries=queries,
        )

    except Exception as exc:  # noqa: BLE001
        # Log the detail server-side; return a generic message to the client.
        # The original returned str(e) to the browser, which risks leaking key
        # fragments, model identifiers and internal stack detail.
        logger.exception("Groq request failed")
        code = type(exc).__name__
        return ChatResult(reply=USER_FACING_ERROR, status="error", error_code=code)


def chat_stream(
    message: str,
    history: Optional[List[Dict]] = None,
    language: Optional[str] = None,
    voice_mode: bool = False,
) -> Iterator[str]:
    """Streams text deltas for one turn, for the voice conversation's
    perceived latency - Aura's reply starts appearing (and can start being
    spoken, sentence by sentence, by the caller) before the model has
    finished generating it.

    DELIBERATE SIMPLIFICATION vs chat(): no web-search tool round trip here.
    Tool calls do not stream cleanly (Groq sends them as accumulating
    argument-string deltas, and this endpoint exists specifically for the
    low-latency voice path where a multi-second tool round trip would defeat
    the point). A caller whose message would have needed a search still gets
    a normal, honest reply - just without live web results - rather than a
    broken or blocked stream. The text Companion keeps using chat() with
    full tool support.

    Yields plain text deltas only. Raises nothing - errors yield the same
    user-facing error string chat() would return, as a single chunk.
    """
    history = history or []
    if not message or not message.strip():
        return

    try:
        client = _get_client()
    except RuntimeError as exc:
        logger.warning("Companion unavailable: %s", exc)
        yield USER_FACING_ERROR
        return

    messages = _build_messages(message, history, language, voice_mode)

    try:
        stream = client.chat.completions.create(
            model=MODEL,
            messages=messages,
            max_tokens=MAX_TOKENS,
            stream=True,
        )
        for chunk in stream:
            delta = chunk.choices[0].delta.content if chunk.choices else None
            if delta:
                yield delta
    except Exception:  # noqa: BLE001
        logger.exception("Groq streaming request failed")
        yield USER_FACING_ERROR


def transcribe(audio_bytes: bytes, filename: str = "audio.webm") -> Dict:
    """Groq Whisper transcription.

    Operates on bytes in memory. The original wrote the upload to a temp file
    on disk; keeping it in memory avoids leaving voice recordings of abuse
    disclosures on the filesystem if cleanup fails.
    """
    if not audio_bytes:
        return {"success": False, "status": "error", "error": "empty_audio"}
    try:
        client = _get_client()
    except RuntimeError as exc:
        return {"success": False, "status": "unavailable", "error": str(exc)}

    try:
        transcription = client.audio.transcriptions.create(
            file=(filename, audio_bytes),
            model=TRANSCRIBE_MODEL,
            response_format="text",
        )
        text = transcription if isinstance(transcription, str) else getattr(
            transcription, "text", ""
        )
        return {"success": True, "status": "success", "text": text}
    except Exception:  # noqa: BLE001
        logger.exception("Transcription failed")
        return {"success": False, "status": "error", "error": "transcription_failed"}


def synthesize_speech(text: str) -> Dict:
    """Text-to-speech via Groq (PlayAI). Returns raw audio bytes in memory -
    never written to disk, same as transcribe() above.

    A synthesis failure degrades to no audio; it must never break the chat
    reply that has already been shown to the user.
    """
    text = (text or "").strip()
    if not text:
        return {"success": False, "status": "error", "error": "empty_text"}
    try:
        client = _get_client()
    except RuntimeError as exc:
        return {"success": False, "status": "unavailable", "error": str(exc)}

    try:
        response = client.audio.speech.create(
            input=text[:MAX_TTS_CHARS],
            model=TTS_MODEL,
            voice=TTS_VOICE,
            # canopylabs/orpheus-v1-english only accepts "wav" - unlike
            # Groq's other TTS models, it rejects "mp3" outright (HTTP 400).
            response_format="wav",
        )
        return {
            "success": True,
            "status": "success",
            "audio": response.read(),
            "content_type": "audio/wav",
        }
    except Exception:  # noqa: BLE001
        logger.exception("Speech synthesis failed")
        return {"success": False, "status": "error", "error": "tts_failed"}
