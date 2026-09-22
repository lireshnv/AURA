/** Client for My Safety Plan + Trusted Contacts. Requires a real signed-in
 * session (unlike the twin/check-in APIs) since this data is per-account. */
import { API_BASE_URL } from "./api"
import { authHeader } from "./authToken"

const BASE = `${API_BASE_URL}/api/safety-plan`

export interface TrustedContact {
  id: string
  name: string
  relationship_label: string | null
  phone: string | null
  email: string | null
  notes: string | null
}

export interface SafetyPlanData {
  exists: boolean
  warning_signs: string[]
  coping_things: string[]
  contact_ids: string[]
  professional_contact: string | null
  updated_at?: string
}

async function request<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...authHeader(), ...(init?.headers || {}) },
      credentials: "include",
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

export const fetchSafetyPlan = () =>
  request<{ success: boolean; plan: SafetyPlanData }>("")

export const saveSafetyPlan = (plan: {
  warning_signs: string[]
  coping_things: string[]
  contact_ids: string[]
  professional_contact: string | null
}) => request<{ success: boolean; plan: SafetyPlanData }>("", { method: "PUT", body: JSON.stringify(plan) })

export const fetchTrustedContacts = () =>
  request<{ success: boolean; contacts: TrustedContact[] }>("/contacts")

export const addTrustedContact = (contact: Omit<TrustedContact, "id">) =>
  request<{ success: boolean; contact: TrustedContact }>("/contacts", {
    method: "POST",
    body: JSON.stringify(contact),
  })

export const updateTrustedContact = (id: string, contact: Omit<TrustedContact, "id">) =>
  request<{ success: boolean; contact: TrustedContact }>(`/contacts/${id}`, {
    method: "PUT",
    body: JSON.stringify(contact),
  })

export const deleteTrustedContact = (id: string) =>
  request<{ success: boolean; deleted: boolean }>(`/contacts/${id}`, { method: "DELETE" })
