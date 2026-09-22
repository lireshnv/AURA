/** Client for the Personal Well-being Digital Twin service. */
import { API_BASE_URL } from "./api"

const TWIN = `${API_BASE_URL}/api/twin`

export type ConsentScope =
  | "baseline"
  | "checkins"
  | "emotion_signals"
  | "session_history"
  | "companion_care"
export type ModalityStatus = "available" | "Insufficient signal"

export interface TwinView {
  success: boolean
  has_data: boolean
  consent: Record<ConsentScope, boolean>
  baseline: {
    status: "ready" | "building"
    status_label: string
    confidence: number
    confidence_label: string
    confidence_dots: number
    observations: number
    checkins_recorded: number
    checkins_needed: number
    values: Record<string, number>
    questionnaire_submitted: boolean
  }
  current: {
    available: boolean
    self_report: Record<string, number> | null
    observations: number
    last_checkin_at: string | null
    emotion: { dominant: string; confidence: number; at: string } | null
    sentiment: { dominant: string; scores: Record<string, number> } | null
  }
  change:
    | {
        available: true
        per_dimension: Record<string, number>
        overall: number
        worsening: string[]
        improving: string[]
      }
    | { available: false; reason: string }
  trend:
    | { available: true; direction: string; label: string; sessions_compared: number }
    | { available: false; reason: string; sessions_compared: number; needed: number }
  engagement: {
    checkin_streak: number
    checkins_last_7d: number
    expected_last_7d: number
    missed_last_7d: number
    days_since_last_checkin: number | null
    engagement_ratio: number
    changed: boolean
  }
  recent_changes: { signal: string; direction: string; text: string }[]
  modality_status: Record<string, ModalityStatus>
  pattern_label: string
  counts: { checkins: number; sessions: number }
  safety_note: string
}

export interface BaselineQuestion {
  id: string
  prompt: string
  type: "slider" | "choice"
  low?: string
  high?: string
  options?: string[]
}

export interface TrendSeriesPoint {
  date: string
  value: number
  points: number
}

export interface TrendsResponse {
  success: boolean
  windows: Record<
    string,
    {
      window_days: number
      checkin_count: number
      session_count: number
      self_report: { available: boolean; value: number | null; points: number }
      sentiment: { available: boolean; negative_mean: number | null; points: number }
      emotion: { available: boolean; confidence_mean: number | null; points: number }
      engagement: { available: boolean; checkins: number; expected: number; ratio: number }
    }
  >
  series: Record<string, TrendSeriesPoint[]>
  note: string
}

export interface PrivacyInfo {
  success: boolean
  consent: Record<ConsentScope, boolean>
  stored: {
    checkins: number
    signal_observations: number
    baseline_submissions: number
    earliest_record: string | null
    storage_location: string
    raw_media_stored: boolean
    transcript_text_stored: boolean
  }
  what_we_collect: string[]
  what_we_never_store: string[]
  why: string
  who_can_access: string
}

export type CareActivityType = "breathing" | "journaling" | "walking" | "relaxation"

export interface CareSummary {
  success: boolean
  consent: boolean
  today: { feed: boolean; water: boolean; checkin: boolean; activity: boolean }
  pet: { total_feedings: number; growth_stage: number; next_stage_in: number }
  plant: { total_waterings: number; growth_stage: number; next_stage_in: number }
  activity: { total_completed: number }
  care_streak_days: number
  recent_activities: CareActivityType[]
}

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${TWIN}${path}`, { signal: AbortSignal.timeout(20000) })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

export const fetchTwinView = () => getJson<TwinView>("/view")
export const fetchTwinTrends = () => getJson<TrendsResponse>("/trends")
export const fetchPrivacy = () => getJson<PrivacyInfo>("/privacy")
export const fetchBaselineQuestions = () =>
  getJson<{ intro: string; questions: BaselineQuestion[]; note: string }>("/baseline/questions")

export async function setConsent(scope: ConsentScope, granted: boolean) {
  const res = await fetch(`${TWIN}/consent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope, granted }),
  })
  return res.json()
}

export async function submitBaseline(answers: Record<string, number | string>) {
  const res = await fetch(`${TWIN}/baseline`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(answers),
  })
  return res.json()
}

export async function submitCheckin(values: Record<string, number | string | boolean>) {
  const res = await fetch(`${TWIN}/checkin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(values),
  })
  return res.json()
}

/**
 * Sends structured signals from the emotion dashboard to the twin.
 * Fire-and-forget: a refused or failed ingest must never disturb analysis.
 */
export async function ingestSignals(payload: Record<string, unknown>) {
  try {
    const res = await fetch(`${TWIN}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    return await res.json()
  } catch {
    return { success: false, stored: false }
  }
}

export interface CheckinEntry {
  id: string
  created_at: string
  note: string | null
  skipped: boolean
  [dimension: string]: unknown
}

export const fetchCheckins = (days?: number) =>
  getJson<{ success: boolean; count: number; checkins: CheckinEntry[] }>(
    days ? `/checkins?days=${days}` : "/checkins"
  )

export const fetchCareToday = () => getJson<CareSummary>("/care/today")

export async function submitCareAction(
  kind: "feed" | "water" | "activity",
  activityType?: CareActivityType
): Promise<CareSummary | { success: false; error: string; required_consent?: string }> {
  try {
    const res = await fetch(`${TWIN}/care/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, activity_type: activityType }),
    })
    return await res.json()
  } catch {
    return { success: false, error: "network_error" }
  }
}

export async function deleteAllTwinData() {
  const res = await fetch(`${TWIN}/privacy/all`, { method: "DELETE" })
  return res.json()
}

export async function exportTwinData() {
  const res = await fetch(`${TWIN}/privacy/export`)
  return res.json()
}
