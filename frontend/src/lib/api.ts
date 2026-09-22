import {
  AnalyzeResponse,
  AuraAnalysis,
  DistressSignalResponse,
  EmotionScores,
  GroqTranscriptAnalysis,
  HistoryResponse,
  MultimodalResponse,
  Observation,
  SessionReport,
  VoiceFrame,
  VoiceCapabilities,
  VoiceObservation,
} from "../types"

// 127.0.0.1 rather than "localhost" deliberately. On Windows, "localhost"
// resolves to ::1 first; the backend binds IPv4, so every NEW connection pays
// a ~2s IPv6 connect timeout before falling back. Keep-alive hides this for
// most requests, but the first one of a session - and any reconnect - would
// stall. Measured: 2062ms per fresh connection vs 4ms to the explicit address.
export const API_BASE_URL = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8000"

export async function analyzeEmotion(
  blob: Blob,
  sessionId: string,
  signal?: AbortSignal
): Promise<AnalyzeResponse> {
  const form = new FormData()
  form.append("session_id", sessionId)
  form.append("frame", blob, "frame.jpg")

  const res = await fetch(`${API_BASE_URL}/api/analyze-emotion`, {
    method: "POST",
    body: form,
    signal,
  })

  if (!res.ok) {
    throw new Error(`Analysis request failed with status ${res.status}`)
  }

  return res.json()
}

export async function checkBackendHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/health`, { signal: AbortSignal.timeout(4000) })
    if (!res.ok) return false
    const data = await res.json()
    return data.status === "ok"
  } catch {
    return false
  }
}

export async function submitSessionReport(
  observations: Observation[],
  voiceObservations: VoiceObservation[] = [],
  agreementSamples: number[] = []
): Promise<SessionReport> {
  const res = await fetch(`${API_BASE_URL}/api/session/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      observations,
      voice_observations: voiceObservations,
      agreement_samples: agreementSamples,
    }),
  })
  if (!res.ok) {
    throw new Error(`Report request failed with status ${res.status}`)
  }
  return res.json()
}

// --- Voice / speech / text -------------------------------------------------

export async function fetchVoiceCapabilities(): Promise<VoiceCapabilities | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/voice/capabilities`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}

/**
 * One real-time voice window. The server runs speech-to-text and acoustic
 * analysis in parallel and returns a single validated, time-stamped frame.
 *
 * `isFinal` selects the accurate once-per-utterance pass over the fast partial
 * pass. Window bounds are the CLIENT's session clock, so a transcript and an
 * acoustic reading for the same span can be aligned downstream.
 */
export async function analyzeVoiceFrame(
  wav: Blob,
  opts: {
    sessionId: string
    windowStart: number
    windowEnd: number
    isFinal?: boolean
    includeTranscript?: boolean
    language?: string
    signal?: AbortSignal
  }
): Promise<VoiceFrame> {
  const form = new FormData()
  form.append("audio", wav, "window.wav")
  form.append("session_id", opts.sessionId)
  form.append("window_start", String(opts.windowStart))
  form.append("window_end", String(opts.windowEnd))
  form.append("is_final", String(opts.isFinal ?? false))
  form.append("include_transcript", String(opts.includeTranscript ?? true))
  if (opts.language) form.append("language", opts.language)

  const res = await fetch(`${API_BASE_URL}/api/voice/frame`, {
    method: "POST",
    body: form,
    signal: opts.signal,
  })
  if (!res.ok) throw new Error(`Voice frame failed with status ${res.status}`)
  return res.json()
}

/** Clears a session's vocal baseline so one speaker's does not leak into the next. */
export async function resetVoiceSession(sessionId: string): Promise<void> {
  const form = new FormData()
  form.append("session_id", sessionId)
  try {
    await fetch(`${API_BASE_URL}/api/voice/session/reset`, { method: "POST", body: form })
  } catch {
    // A failed reset degrades baseline accuracy slightly; it must never stop
    // a session from starting.
  }
}

/**
 * ONE-CLICK analysis. Sends the current per-modality readings and gets back a
 * combined signal plus an explainable breakdown. `*_detail` carries extra
 * context used only for the explanation - never for scoring.
 */
export async function analyseSession(
  body: {
    face?: { scores: EmotionScores | Record<string, number>; confidence: number; quality: number } | null
    voice?: { scores: Record<string, number>; confidence: number; quality: number } | null
    text?: { scores: Record<string, number>; confidence: number; quality: number } | null
    face_detail?: Record<string, unknown> | null
    voice_detail?: Record<string, unknown> | null
    text_detail?: Record<string, unknown> | null
    trend?: { direction: string | null; emotion: string | null; delta: number } | null
  },
  signal?: AbortSignal
): Promise<AuraAnalysis> {
  const res = await fetch(`${API_BASE_URL}/api/session/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    throw new Error(`Analysis failed with status ${res.status}`)
  }
  return res.json()
}

/**
 * Groq's structured, qualitative read of one SETTLED transcript segment -
 * only ever call this with validated/stable (final-pass) transcript, never a
 * live partial. Degrades to `{available: false, reason}` rather than
 * throwing when Groq isn't configured or the transcript is too thin.
 */
export async function analyzeTranscriptWithGroq(
  transcript: string,
  sessionId?: string
): Promise<GroqTranscriptAnalysis> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/text/groq-analysis`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript, session_id: sessionId }),
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) return { available: false, reason: `http_${res.status}` }
    const data = await res.json()
    return data.success ? (data as GroqTranscriptAnalysis) : { available: false, reason: data.error ?? "unknown" }
  } catch {
    return { available: false, reason: "request_failed" }
  }
}

// --- Distress signal + history ---------------------------------------------

export async function fetchDistressSignal(
  body: {
    emotion_window: Record<string, number>[]
    sentiment_window: Record<string, number>[]
    voice_stress?: number | null
    face_motion?: number | null
    reliability?: number
    transcript?: string | null
  },
  signal?: AbortSignal
): Promise<DistressSignalResponse | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/distress/signal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}

export async function fetchHistory(limit = 50): Promise<HistoryResponse | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/history/sessions?limit=${limit}`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}

/** Persists a completed session. Derived signals only - never raw media. */
export async function saveHistorySession(
  record: Record<string, unknown>
): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/history/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    })
    if (!res.ok) return null
    const data = await res.json()
    return data.success ? data.id : null
  } catch {
    return null
  }
}

export async function clearHistory(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/history/sessions`, { method: "DELETE" })
    return res.ok
  } catch {
    return false
  }
}

export async function fuseModalities(
  face: { scores: EmotionScores; confidence: number; quality: number } | null,
  voice: { scores: Record<string, number>; confidence: number; quality: number } | null,
  text: { scores: Record<string, number>; confidence: number; quality: number } | null,
  signal?: AbortSignal
): Promise<MultimodalResponse> {
  const res = await fetch(`${API_BASE_URL}/api/multimodal/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ face, voice, text }),
    signal,
  })
  if (!res.ok) {
    throw new Error(`Multimodal fusion failed with status ${res.status}`)
  }
  return res.json()
}
