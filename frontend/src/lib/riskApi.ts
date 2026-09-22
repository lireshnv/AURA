/** Client for Risk & Trend, human review and the audit log. */
import { API_BASE_URL } from "./api"
import { authHeader } from "./authToken"

const RISK = `${API_BASE_URL}/api/risk`

export interface Contribution {
  signal: string
  strength: "HIGH" | "MEDIUM" | "LOW" | "NONE"
  value: number | null
  weight: number
  available: boolean
}

export interface BaselineComparison {
  dimension: string
  baseline: number
  current: number
  delta: number
  direction: "up" | "down" | "flat"
}

export interface RiskAssessmentView {
  success: boolean
  available: boolean
  status: "STABLE" | "IMPROVING" | "CHANGING" | "NEEDS_REVIEW" | "BUILDING"
  status_label: string
  reason?: string
  band?: "GREEN" | "AMBER" | "RED"
  distress_signal: number | null
  confidence: number | null
  checkins_recorded?: number
  checkins_needed?: number
  trend?: { direction: string; label: string; sessions_compared: number }
  contributions: Contribution[]
  comparison: BaselineComparison[]
  contributing_factors: { factor: string; direction: string; detail: string }[]
  recent_changes: string[]
  limitations: string[]
  modalities: Record<
    string,
    { available: boolean; confidence: number | null; observations: number; note: string }
  >
  consistency: {
    available: boolean
    reason?: string
    directions?: Record<string, string>
    consistent?: boolean
    label?: string
  }
  human_review_required: boolean
  autonomous_action?: boolean
  escalation_note?: string
  disclaimer: string
  data_quality?: { checkins: number; sessions: number; baseline_confidence: number }
}

export interface RiskHistory {
  success: boolean
  available: boolean
  reason: string | null
  points: { date: string; value: number; band: string; confidence: number }[]
  days?: number
}

export interface AuditEntry {
  id: string
  timestamp: string
  aura_id: string
  action: string
  actor_role: string
  actor_id: string | null
  reason: string | null
}

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${RISK}${path}`, {
      headers: { ...authHeader() },
      credentials: "include",
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

export interface AuditEntryRow {
  id: string
  timestamp: string
  aura_id: string
  action: string
  actor_role: string
  actor_id: string | null
  reason: string | null
}

export const fetchAuditLog = (limit = 100) =>
  getJson<{ success: boolean; entries: AuditEntryRow[]; note: string }>(`/audit?limit=${limit}`)

export const fetchRiskAssessment = () => getJson<RiskAssessmentView>("/assessment")
export const fetchRiskHistory = (days = 7) => getJson<RiskHistory>(`/history?days=${days}`)

/** Records a human action. Always audited; never contacts anyone externally. */
export async function recordReview(body: {
  aura_id?: string
  action: string
  actor_role: string
  actor_id?: string
  reason?: string
}) {
  try {
    const res = await fetch(`${RISK}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aura_id: "local-user", ...body }),
    })
    return await res.json()
  } catch {
    return { success: false, error: "Could not reach the service." }
  }
}
