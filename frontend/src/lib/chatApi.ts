/**
 * Client for the AURA Companion.
 *
 * Talks ONLY to AURA's own backend. The Groq key lives server-side and is
 * never present in the browser bundle or in any network response.
 */
import { API_BASE_URL } from "./api"

const CHAT = `${API_BASE_URL}/api/chat`

export interface ChatMessage {
  role: "user" | "assistant"
  content: string
}

export interface SafetyResource {
  label: string
  detail: string
  priority: string
}

export interface SafetyBlock {
  triggered: boolean
  severity: "urgent" | "elevated"
  message: string
  resources: SafetyResource[]
}

export interface ChatReply {
  response: string
  session_id: string
  status: "success" | "unavailable" | "error"
  safety?: SafetyBlock | null
  used_web_search?: boolean
}

export interface CompanionStatus {
  success: boolean
  groq_installed: boolean
  api_key_configured: boolean
  web_search_available: boolean
  model: string
  ready: boolean
  note: string
  safety_layer: string
  tts_available: boolean
}

export async function fetchCompanionStatus(): Promise<CompanionStatus | null> {
  try {
    const res = await fetch(`${CHAT}/status`, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}

export async function sendChatMessage(
  message: string,
  sessionId: string | null,
  language?: string
): Promise<ChatReply> {
  try {
    const res = await fetch(CHAT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, session_id: sessionId, language }),
      signal: AbortSignal.timeout(60000),
    })

    if (res.status === 429) {
      return {
        response: "You're sending messages very quickly. Please wait a moment.",
        session_id: sessionId ?? "",
        status: "error",
      }
    }
    if (!res.ok) {
      // Never surface backend error bodies to the user.
      return {
        response: "Sorry, I'm temporarily unavailable. Please try again.",
        session_id: sessionId ?? "",
        status: "error",
      }
    }
    return await res.json()
  } catch {
    return {
      response: "Sorry, I'm temporarily unavailable. Please try again.",
      session_id: sessionId ?? "",
      status: "error",
    }
  }
}

export interface StreamHandlers {
  onSessionId?: (id: string) => void
  onDelta: (text: string) => void
  onSafety?: (safety: SafetyBlock) => void
  onDone?: () => void
}

/**
 * Streams one turn as Server-Sent Events so the reply can start appearing
 * (and being spoken, sentence by sentence, by the caller) before generation
 * finishes. Falls back silently to nothing further on any read error - the
 * caller already has whatever text arrived before the failure.
 */
export async function streamChatMessage(
  message: string,
  sessionId: string | null,
  language: string | undefined,
  voiceMode: boolean,
  handlers: StreamHandlers,
  signal?: AbortSignal,
  turnId?: string
): Promise<void> {
  let res: Response
  try {
    res = await fetch(`${CHAT}/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        session_id: sessionId,
        language,
        voice_mode: voiceMode,
        turn_id: turnId,
      }),
      signal,
    })
  } catch {
    handlers.onDelta(USER_FACING_ERROR)
    handlers.onDone?.()
    return
  }
  if (!res.ok || !res.body) {
    handlers.onDelta(USER_FACING_ERROR)
    handlers.onDone?.()
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith("data:")) continue
        let event: { type: string; [k: string]: unknown }
        try {
          event = JSON.parse(trimmed.slice(5).trim())
        } catch {
          continue
        }
        if (event.type === "session" && typeof event.session_id === "string") {
          handlers.onSessionId?.(event.session_id)
        } else if (event.type === "delta" && typeof event.text === "string") {
          handlers.onDelta(event.text)
        } else if (event.type === "safety") {
          handlers.onSafety?.(event as unknown as SafetyBlock)
        } else if (event.type === "done") {
          handlers.onDone?.()
        }
      }
    }
  } catch (err) {
    if ((err as Error)?.name !== "AbortError") {
      /* a dropped stream mid-reply is non-fatal; whatever text arrived stays on screen */
    }
  }
}

const USER_FACING_ERROR = "Sorry, I'm temporarily unavailable. Please try again."

export async function fetchHistory(sessionId: string): Promise<ChatMessage[]> {
  try {
    const res = await fetch(`${CHAT}/history?session_id=${encodeURIComponent(sessionId)}`)
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data.messages) ? data.messages : []
  } catch {
    return []
  }
}

export async function startNewConversation(): Promise<string | null> {
  try {
    const res = await fetch(`${CHAT}/new`, { method: "POST" })
    if (!res.ok) return null
    return (await res.json()).session_id
  } catch {
    return null
  }
}

export async function clearConversation(sessionId: string): Promise<boolean> {
  try {
    const res = await fetch(`${CHAT}/${sessionId}`, { method: "DELETE" })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Runs the same deterministic crisis-safety layer used on every chat message,
 * for surfaces outside the Companion chat (e.g. a Check-In note). Returns
 * null when nothing is triggered, or when the check itself is unavailable -
 * a failed safety check must never be shown as a false "all clear" banner,
 * so callers should treat null as "no signal", not "confirmed safe".
 */
export async function checkTextSafety(text: string): Promise<SafetyBlock | null> {
  try {
    const res = await fetch(`${CHAT}/safety-check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return null
    const data = await res.json()
    return data.success && data.safety ? (data.safety as SafetyBlock) : null
  } catch {
    return null
  }
}

export async function transcribeVoice(blob: Blob): Promise<string | null> {
  try {
    const form = new FormData()
    form.append("audio", blob, "voice.webm")
    const res = await fetch(`${CHAT}/transcribe`, { method: "POST", body: form })
    if (!res.ok) return null
    const data = await res.json()
    return data.success ? data.text : null
  } catch {
    return null
  }
}

/**
 * Fetches spoken audio for one reply and returns a playable object URL, or
 * null if synthesis is unavailable/failed - the caller shows the text-only
 * reply either way, so a TTS failure never blocks the conversation.
 */
export async function speakText(text: string): Promise<string | null> {
  try {
    const res = await fetch(`${CHAT}/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) return null
    const blob = await res.blob()
    return URL.createObjectURL(blob)
  } catch {
    return null
  }
}

export interface SpeechAlignment {
  characters: string[]
  character_start_times_seconds: number[]
  character_end_times_seconds: number[]
}

export interface SpeechChunk {
  audio_base64: string
  alignment?: SpeechAlignment
  normalized_alignment?: SpeechAlignment
}

export interface SpeechStreamHandlers {
  onChunk: (chunk: SpeechChunk) => void
}

/**
 * Streams TTS for one sentence as newline-delimited JSON, so playback (and
 * word highlighting, via each chunk's `alignment`) can start on the first
 * chunk instead of waiting for the whole sentence to synthesize.
 *
 * Returns whether at least one usable chunk arrived. `false` means "nothing
 * streamed" (ElevenLabs unavailable, network failure, or an interrupt before
 * the first byte) - the caller falls back to the batch speakText() above,
 * never leaving the reply unspoken because streaming alone failed.
 */
export async function streamSpeech(
  text: string,
  handlers: SpeechStreamHandlers,
  signal?: AbortSignal
): Promise<boolean> {
  let res: Response
  try {
    res = await fetch(`${CHAT}/speak/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal,
    })
  } catch {
    return false
  }
  if (!res.ok || !res.body) return false

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let receivedAny = false

  const consumeLine = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      const chunk = JSON.parse(trimmed) as SpeechChunk
      if (chunk.audio_base64) {
        receivedAny = true
        handlers.onChunk(chunk)
      }
    } catch {
      /* malformed line - skip it, the rest of the stream still matters */
    }
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) consumeLine(line)
    }
    if (buffer.trim()) consumeLine(buffer)
  } catch (err) {
    if ((err as Error)?.name !== "AbortError") {
      /* a dropped stream mid-sentence is non-fatal - whatever audio already
         played/scheduled stays; the caller just doesn't get more chunks */
    }
  }
  return receivedAny
}
