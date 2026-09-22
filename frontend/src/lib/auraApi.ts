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
    escalation_risk: {
      available: boolean
      level: "low" | "elevated" | "high" | "insufficient_data"
      consecutive_worsening: number
      volatility: number
      rationale: string
    }
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
  escalation_risk: "low" | "elevated" | "high" | "insufficient_data"
  escalation_rationale: string
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

export interface CaseTypeRecord {
  success: boolean
  has_data: boolean
  case_type: string | null
  notes: string | null
  district: string | null
  state: string | null
}

export const fetchCaseType = (auraId: string) => getJson<CaseTypeRecord>(`${AURA}/case-type/${auraId}`)

export async function setCaseType(
  auraId: string,
  caseType: string,
  extra?: { notes?: string; district?: string; state?: string }
) {
  try {
    const res = await fetch(`${AURA}/case-type/${auraId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeader() },
      credentials: "include",
      body: JSON.stringify({ case_type: caseType, ...extra }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { success: false, error: data.detail ?? "Could not save case type." }
    return { success: true, ...data }
  } catch {
    return { success: false, error: "Could not reach the server." }
  }
}

export interface DistrictRollup {
  district: string
  total: number
  green: number
  amber: number
  red: number
}

export interface StateRollup {
  state: string
  total: number
  green: number
  amber: number
  red: number
  districts: DistrictRollup[]
}

export interface HighRiskCase {
  aura_id: string
  case_type: string
  district: string | null
  state: string | null
  risk_score: number
  priority: number
}

export interface EscalatingCase {
  aura_id: string
  case_type: string
  district: string | null
  state: string | null
  current_band: RiskBand
  rationale: string
  priority: number
}

export interface GeoOverview {
  success: boolean
  national: { total: number; green: number; amber: number; red: number; unassessed: number }
  by_case_type: Record<string, number>
  states: StateRollup[]
  high_risk_cases: HighRiskCase[]
  escalating_cases: EscalatingCase[]
}

export const fetchGeoOverview = () => getJson<GeoOverview>(`${AURA}/geo-overview`)

export async function acknowledgeHighRiskCase(auraId: string) {
  try {
    const res = await fetch(`${AURA}/geo-overview/acknowledge/${auraId}`, {
      method: "POST",
      headers: { ...authHeader() },
      credentials: "include",
    })
    return await res.json().catch(() => ({ success: res.ok }))
  } catch {
    return { success: false, error: "Could not reach the server." }
  }
}

export interface Acknowledgement {
  actor_role: string
  at: string
}

export const fetchAcknowledgements = (auraId: string) =>
  getJson<{ success: boolean; acknowledgements: Acknowledgement[] }>(
    `${AURA}/geo-overview/acknowledgements/${auraId}`
  )

export const fetchSupportHistory = (auraId: string) =>
  getJson<{ success: boolean; interventions: InterventionRecord[] }>(`${AURA}/support/history/${auraId}`)

export interface CaseDocumentRecord {
  id: string
  name: string
  label: string | null
  content_type: string
  size_bytes: number
  uploaded_by_role: string
  created_at: string
}

export const fetchCaseDocuments = (auraId: string) =>
  getJson<{ success: boolean; documents: CaseDocumentRecord[] }>(`${AURA}/case-documents/${auraId}`)

export async function uploadCaseDocument(auraId: string, file: File, label?: string) {
  try {
    const form = new FormData()
    form.append("file", file)
    const params = new URLSearchParams()
    if (label) params.set("label", label)
    const res = await fetch(`${AURA}/case-documents/${auraId}${params.toString() ? `?${params}` : ""}`, {
      method: "POST",
      headers: { ...authHeader() }, // no Content-Type - the browser sets the multipart boundary
      credentials: "include",
      body: form,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { success: false, error: data.detail ?? "Could not upload the document." }
    return { success: true, ...data }
  } catch {
    return { success: false, error: "Could not reach the server." }
  }
}

/** Downloads are auth-gated, so a plain <a href> can't be used (the browser
 * won't attach the JWT) - fetch as a blob and trigger a save via an object URL. */
export async function downloadCaseDocument(auraId: string, documentId: string, filename: string) {
  try {
    const res = await fetch(`${AURA}/case-documents/${auraId}/${documentId}/download`, {
      headers: { ...authHeader() },
      credentials: "include",
    })
    if (!res.ok) return { success: false, error: "Could not download the document." }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
    return { success: true }
  } catch {
    return { success: false, error: "Could not reach the server." }
  }
}

export async function deleteCaseDocument(auraId: string, documentId: string) {
  try {
    const res = await fetch(`${AURA}/case-documents/${auraId}/${documentId}`, {
      method: "DELETE",
      headers: { ...authHeader() },
      credentials: "include",
    })
    return await res.json().catch(() => ({ success: res.ok }))
  } catch {
    return { success: false, error: "Could not reach the server." }
  }
}
