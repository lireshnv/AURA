/** Client for AURA calls - counsellor-generated wellness calls to a victim,
 * plus the earlier self-initiated path (unused by the current victim UI,
 * kept working). A separate feature from the main Emotion Analysis
 * pipeline. */
import { API_BASE_URL } from "./api"
import { authHeader, getToken } from "./authToken"

const IVRS = `${API_BASE_URL}/api/ivrs`

export interface CallReasonOption {
  key: string
  label: string
  emoji: string
  message: string
}

export interface StartCallResponse {
  success: boolean
  call_id: string
  reason_key: string
  reason_label: string
  reason_emoji: string
  opening_text: string
  status: string
}

export interface GenerateCallResponse {
  success: boolean
  call_id: string
  victim_aura_id: string
  reason_key: string
  reason_label: string
  message: string
  status: string
  error?: string
}

export interface TurnResponse {
  success: boolean
  user_text?: string
  aura_text?: string
  aura_status?: string
  tts_available?: boolean
  error?: string
  message?: string
}

export interface IvrsStatus {
  success: boolean
  groq_configured: boolean
  elevenlabs_tts_configured: boolean
  ready: boolean
  note: string
}

export type CallEvent =
  | { type: "state"; state: "ringing" | "listening" | "thinking" | "speaking" | "idle" | "ended" }
  | { type: "turn"; role: "user" | "aura"; text: string }

export type NotificationEvent = {
  type: "incoming_call"
  call_id: string
  reason_key: string
  reason_label: string
  reason_emoji: string
  message: string
}

export const fetchIvrsStatus = async (): Promise<IvrsStatus | null> => {
  try {
    const res = await fetch(`${IVRS}/status`, { signal: AbortSignal.timeout(6000) })
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}

export const fetchCallReasons = async (): Promise<CallReasonOption[]> => {
  try {
    const res = await fetch(`${IVRS}/reasons`, { signal: AbortSignal.timeout(6000) })
    if (!res.ok) return []
    const data = await res.json()
    return data.reasons ?? []
  } catch {
    return []
  }
}

/** Counsellor-facing: places a real call to an authorised victim. */
export async function generateCall(
  victimAuraId: string,
  reasonKey: string,
  customMessage?: string
): Promise<GenerateCallResponse | null> {
  try {
    const res = await fetch(`${IVRS}/call/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({ victim_aura_id: victimAuraId, reason_key: reasonKey, custom_message: customMessage }),
      credentials: "include",
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      return { success: false, error: data.detail ?? `http_${res.status}` } as GenerateCallResponse
    }
    return res.json()
  } catch {
    return { success: false, error: "network_error" } as GenerateCallResponse
  }
}

export async function startCall(reasonKey: string, customReason?: string): Promise<StartCallResponse | null> {
  try {
    const res = await fetch(`${IVRS}/call/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({ reason_key: reasonKey, custom_reason: customReason }),
    })
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}

export interface IvrsCallSummary {
  id: string
  aura_id: string
  reason_key: string
  custom_reason: string | null
  status: string
  started_at: string
  answered_at: string | null
  ended_at: string | null
  counsellor_user_id: string | null
  message: string | null
}

export async function fetchCallHistory(): Promise<IvrsCallSummary[]> {
  try {
    const res = await fetch(`${IVRS}/calls`, { headers: { ...authHeader() }, credentials: "include" })
    if (!res.ok) return []
    const data = await res.json()
    return data.calls ?? []
  } catch {
    return []
  }
}

/** Counsellor-facing: calls this counsellor has actually generated. */
export async function fetchGeneratedCalls(): Promise<IvrsCallSummary[]> {
  try {
    const res = await fetch(`${IVRS}/calls/generated`, { headers: { ...authHeader() }, credentials: "include" })
    if (!res.ok) return []
    const data = await res.json()
    return data.calls ?? []
  } catch {
    return []
  }
}

/** Call history for one victim - authorised for that victim, their assigned
 * counsellor, their linked guardian, or an admin (checked server-side). */
export async function fetchVictimCallHistory(victimAuraId: string): Promise<IvrsCallSummary[]> {
  try {
    const res = await fetch(`${IVRS}/calls/${victimAuraId}/history`, { headers: { ...authHeader() }, credentials: "include" })
    if (!res.ok) return []
    const data = await res.json()
    return data.calls ?? []
  } catch {
    return []
  }
}

export async function attendCall(callId: string): Promise<{ success: boolean; opening_text: string } | null> {
  try {
    const res = await fetch(`${IVRS}/call/${callId}/attend`, { method: "POST" })
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}

export async function declineCall(callId: string): Promise<boolean> {
  try {
    const res = await fetch(`${IVRS}/call/${callId}/decline`, { method: "POST" })
    return res.ok
  } catch {
    return false
  }
}

export async function endCall(callId: string): Promise<boolean> {
  try {
    const res = await fetch(`${IVRS}/call/${callId}/end`, { method: "POST" })
    return res.ok
  } catch {
    return false
  }
}

export async function sendTextTurn(callId: string, text: string): Promise<TurnResponse> {
  try {
    const res = await fetch(`${IVRS}/call/${callId}/text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) return { success: false, error: `http_${res.status}` }
    return res.json()
  } catch {
    return { success: false, error: "network_error" }
  }
}

export async function sendAudioTurn(callId: string, blob: Blob): Promise<TurnResponse> {
  try {
    const form = new FormData()
    form.append("audio", blob, "turn.webm")
    const res = await fetch(`${IVRS}/call/${callId}/audio`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) return { success: false, error: `http_${res.status}` }
    return res.json()
  } catch {
    return { success: false, error: "network_error" }
  }
}

/** URL for the browser <audio> element to fetch AURA's exact spoken line. */
export function audioReplyUrl(callId: string, text: string): string {
  return `${IVRS}/call/${callId}/audio-reply?text=${encodeURIComponent(text)}`
}

/** Real-time state/turn events for ONE call. Reconnects are the caller's
 * responsibility; this just wraps one connection attempt. */
export function connectCallSocket(callId: string, onEvent: (e: CallEvent) => void): WebSocket | null {
  try {
    const wsBase = API_BASE_URL.replace(/^http/, "ws")
    const ws = new WebSocket(`${wsBase}/api/ivrs/call/${callId}/ws`)
    ws.onmessage = (msg) => {
      try {
        onEvent(JSON.parse(msg.data) as CallEvent)
      } catch {
        /* malformed event - ignored, the REST response already drives the UI */
      }
    }
    return ws
  } catch {
    return null
  }
}

/**
 * The victim's standing "is a call arriving" channel - open this once when
 * the victim's dashboard loads. Requires a real JWT (sent as a query param,
 * since browsers can't set custom headers on a WebSocket handshake); with no
 * token, returns null rather than opening an unauthenticated connection.
 */
export function connectNotificationSocket(onEvent: (e: NotificationEvent) => void): WebSocket | null {
  const token = getToken()
  if (!token) return null
  try {
    const wsBase = API_BASE_URL.replace(/^http/, "ws")
    const ws = new WebSocket(`${wsBase}/api/ivrs/notify/ws?token=${encodeURIComponent(token)}`)
    ws.onmessage = (msg) => {
      try {
        onEvent(JSON.parse(msg.data) as NotificationEvent)
      } catch {
        /* malformed event - ignored */
      }
    }
    return ws
  } catch {
    return null
  }
}
