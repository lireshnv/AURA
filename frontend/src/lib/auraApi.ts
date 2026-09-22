/**
 * Client for the AURA platform layer (digital twin, risk, case queue, support).
 * Kept separate from lib/api.ts, which owns the raw analysis endpoints, so the
 * platform and the analysis engine stay decoupled.
 *
 * All responses carry REAL stored data. Demo profiles were removed; endpoints
 * report has_data=false and "No data available" when nothing exists.
 */
import { API_BASE_URL } from "./api"
import { authHeader } from "./authToken"

const AURA = `${API_BASE_URL}/api/aura`

export type RiskBand = "GREEN" | "AMBER" | "RED"

export interface SecurityPosture {
  stage: string
  implemented: string[]
  not_implemented: string[]
  warning: string
}

export interface AuraConfig {
  baseline_dimensions: string[]
  score_weights: Record<string, number>
  risk_bands: { band: RiskBand; range: string; routing: string }[]
  security_posture: SecurityPosture
  positioning: string
}

export interface ContributingFactor {
  factor: string
  direction: "up" | "down" | "neutral"
  detail: string
}

export interface RiskAssessment {
  score: number
  band: RiskBand
  level: string
  routing: string
  confidence: number
  components: Record<string, number>
  weights_used: Record<string, number>
  contributing_factors: ContributingFactor[]
  recent_changes: string[]
  case_context: string[]
  limitations: string[]
  human_review_required: boolean
  autonomous_action: boolean
  insufficient_data: boolean
  disclaimer: string
  assessed_at: string
}

export interface TwinResponse {
  success: boolean
  has_data: boolean
  message?: string
  error?: string
  aura_id: string
  twin: {
    aura_id: string
    baseline: {
      values: Record<string, number>
      variation: Record<string, number>
      confidence: number
      observations: number
    }
    current: { values: Record<string, number>; observations: number; last_checkin_at: string | null }
    deviation: {
      per_dimension: Record<string, number>
      overall: number
      worsening: string[]
      improving: string[]
    }
    trend: { direction: string; delta: number; sessions_compared: number; label: string }
    engagement: {
      checkin_streak: number
      checkins_last_7d: number
      expected_last_7d: number
      missed_last_7d: number
      days_since_last_checkin: number | null
      engagement_ratio: number
      changed: boolean
    }
  }
  risk: RiskAssessment
  priority: number
  pattern_label: string
  baseline_confidence_label: string
  counts: { checkins: number; sessions: number }
}

export interface CaseRow {
  aura_id: string
  risk_band: RiskBand
  risk_level: string
  risk_score: number
  confidence: number
  routing: string
  trend: string
  trend_label: string
  days_since_checkin: number | null
  checkins_last_7d: number
  priority: number
  human_review_required: boolean
  insufficient_data: boolean
  top_factors: ContributingFactor[]
  counts: { checkins: number; sessions: number }
}

export interface CaseQueue {
  success: boolean
  error?: string
  synthetic: boolean
  message?: string | null
  summary: {
    total: number
    green: number
    amber: number
    red: number
    pending_review: number
    improving: number
    needs_followup: number
  }
  cases: CaseRow[]
}

export interface SupportSuggestion {
  pathway: string
  reason: string
  urgency: string
  status: string
  requires_human_approval: boolean
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { ...authHeader() },
      credentials: "include",
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

export const fetchTwin = (auraId: string) =>
  getJson<TwinResponse>(`${AURA}/twin/${auraId}`)

export const fetchCaseQueue = () => getJson<CaseQueue>(`${AURA}/cases`)

export const fetchSupportPathways = (auraId: string) =>
  getJson<{ suggestions: SupportSuggestion[]; decision_authority: string; note: string; case_type: string | null }>(
    `${AURA}/support/pathways/${auraId}`
  )

/** Admin-only, non-production-only: writes a small synthetic well-being
 * history through the same real storage path a genuine check-in uses, so the
 * victim dashboard, an assigned counsellor's case queue/Analysis tab, a
 * linked guardian's summary and the admin case list all read the same
 * numbers instead of four separate fabricated ones. */
export async function seedDemoData(): Promise<{ success: boolean; note?: string; error?: string }> {
  try {
    const res = await fetch(`${AURA}/dev/seed-demo-data`, {
      method: "POST",
      headers: { ...authHeader() },
      credentials: "include",
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { success: false, error: data.detail ?? "Could not seed demo data." }
    return { success: true, note: data.note }
  } catch {
    return { success: false, error: "Could not reach the server." }
  }
}

export async function recordSupportDecision(body: {
  aura_id: string
  pathway: string
  decision: "approved" | "rejected" | "escalated"
  decided_by: string
  rationale?: string
}) {
  try {
    const res = await fetch(`${AURA}/support/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      credentials: "include",
      body: JSON.stringify(body),
    })
    return await res.json()
  } catch {
    return { success: false, error: "Could not reach the service." }
  }
}

export interface CaseTypeOption {
  value: string
  label: string
}

export interface InterventionRecord {
  id: string
  pathway: string
  status: string
  reason: string | null
  decided_by: string | null
  decided_at: string | null
  created_at: string
}

export const fetchCaseTypes = () =>
  getJson<{ success: boolean; case_types: CaseTypeOption[] }>(`${AURA}/case-types`)

export const fetchCaseType = (auraId: string) =>
  getJson<{ success: boolean; has_data: boolean; case_type: string | null; notes: string | null }>(
    `${AURA}/case-type/${auraId}`
  )

export async function setCaseType(auraId: string, caseType: string, notes?: string) {
  try {
    const res = await fetch(`${AURA}/case-type/${auraId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeader() },
      credentials: "include",
      body: JSON.stringify({ case_type: caseType, notes }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { success: false, error: data.detail ?? "Could not save case type." }
    return { success: true, ...data }
  } catch {
    return { success: false, error: "Could not reach the server." }
  }
}

export const fetchSupportHistory = (auraId: string) =>
  getJson<{ success: boolean; interventions: InterventionRecord[] }>(`${AURA}/support/history/${auraId}`)
