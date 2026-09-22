/** Client for personalization outcomes ("did that help?"). Requires a real
 * signed-in session, same as safetyPlanApi. */
import { API_BASE_URL } from "./api"
import { authHeader } from "./authToken"

const BASE = `${API_BASE_URL}/api/patterns`

export type InterventionCategory = "calm" | "reset" | "solve" | "restore" | "connect" | "reflect"
export type OutcomeResult = "better" | "slightly_better" | "same" | "worse"

export async function recordOutcome(payload: {
  situation?: string | null
  intervention_category: InterventionCategory
  intervention_type: string
  result: OutcomeResult
}) {
  try {
    const res = await fetch(`${BASE}/outcome`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      credentials: "include",
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return { success: false }
    return await res.json()
  } catch {
    return { success: false }
  }
}

export interface WhatHelpsEntry {
  intervention_type: string
  intervention_category: InterventionCategory
  total: number
  helped: number
  helped_ratio: number
}

export async function fetchWhatHelps(): Promise<{ success: boolean; has_enough_data: boolean; ranked: WhatHelpsEntry[] } | null> {
  try {
    const res = await fetch(`${BASE}/what-helps`, {
      headers: { ...authHeader() },
      credentials: "include",
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}
