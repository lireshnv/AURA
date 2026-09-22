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
