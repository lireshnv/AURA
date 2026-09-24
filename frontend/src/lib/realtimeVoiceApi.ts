/**
 * Client for Aura's realtime full-duplex voice path (Gemini Live, via
 * /api/realtime-voice/ws on AURA's own backend - the browser never talks to
 * Gemini directly, same rule as every other provider in this app). BETA:
 * see backend/app/services/gemini_live.py's module docstring for the
 * free-tier privacy caveat this surface is deliberately gated behind.
 */
import { API_BASE_URL } from "./api"
import { getToken } from "./authToken"
import type { SafetyResource } from "./chatApi"

export interface RealtimeVoiceStatus {
  success: boolean
  ready: boolean
  api_key_configured: boolean
  websockets_installed: boolean
  model: string
  note: string
}

export async function fetchRealtimeVoiceStatus(): Promise<RealtimeVoiceStatus | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/realtime-voice/status`, {
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

export type RealtimeVoiceEvent =
  | { type: "ready"; session_id: string }
  | { type: "unavailable"; reason: string }
  | {
      type: "safety"
      turn_id: string
      severity: "urgent" | "elevated"
      message: string
      resources: SafetyResource[]
    }
  | { type: "output_transcript_delta"; text: string; turn_id: string }
  | { type: "interrupted"; turn_id: string }
  | { type: "turn_complete"; turn_id: string }

export interface RealtimeVoiceSocket {
  ws: WebSocket
  /** Sends one chunk of 16-bit PCM mono mic audio (raw bytes, not base64 -
   * the backend relay expects binary WS frames). */
  sendAudioChunk: (pcm: ArrayBuffer) => void
  close: () => void
}

/**
 * Opens the realtime voice WebSocket. No token → still connects (the
 * backend falls back to a "local-user" identity), matching the rest of this
 * app's single-user-capable prototype behaviour - unlike the IVRS incoming-
 * call notification socket, which requires a real token.
 */
export function connectRealtimeVoiceSocket(
  sessionId: string | null,
  language: string | undefined,
  onEvent: (e: RealtimeVoiceEvent) => void,
  onAudioChunk: (pcm: ArrayBuffer) => void
): RealtimeVoiceSocket {
  const wsBase = API_BASE_URL.replace(/^http/, "ws")
  const url = new URL(`${wsBase}/api/realtime-voice/ws`)
  const token = getToken()
  if (token) url.searchParams.set("token", token)
  if (sessionId) url.searchParams.set("session_id", sessionId)
  if (language) url.searchParams.set("language", language)

  const ws = new WebSocket(url.toString())
  ws.binaryType = "arraybuffer"

  ws.onmessage = (evt) => {
    if (evt.data instanceof ArrayBuffer) {
      onAudioChunk(evt.data)
      return
    }
    try {
      onEvent(JSON.parse(evt.data as string) as RealtimeVoiceEvent)
    } catch {
      /* malformed event - ignore rather than crash the session */
    }
  }

  return {
    ws,
    sendAudioChunk: (pcm: ArrayBuffer) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(pcm)
    },
    close: () => {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "end" }))
      } catch {
        /* already closing */
      }
      ws.close()
    },
  }
}
