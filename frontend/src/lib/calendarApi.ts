/** Client for the shared Aura Calendar - one events table every role's
 * calendar view reads from, scoped per aura_id (case). */
import { API_BASE_URL } from "./api"
import { authHeader } from "./authToken"

const CALENDAR = `${API_BASE_URL}/api/calendar`

export type CalendarEventType =
  | "hearing"
  | "appointment"
  | "counselling_session"
  | "checkin"
  | "officer_meeting"
  | "deadline"
  | "rehabilitation"
  | "compensation"
  | "reminder"
  | "personal_note"

export interface CalendarEventTypeOption {
  value: CalendarEventType
  label: string
}

export interface CalendarEventRecord {
  id: string
  aura_id: string
  title: string
  event_type: CalendarEventType
  starts_at: string
  ends_at: string | null
  location: string | null
  notes: string | null
  created_by_role: string
  status: "scheduled" | "completed" | "cancelled"
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

export const fetchCalendarEventTypes = () =>
  getJson<{ success: boolean; event_types: CalendarEventTypeOption[] }>(`${CALENDAR}/event-types`)

export const fetchCalendarEvents = (auraId: string, range?: { start?: Date; end?: Date }) => {
  const params = new URLSearchParams({ aura_id: auraId })
  if (range?.start) params.set("start", range.start.toISOString())
  if (range?.end) params.set("end", range.end.toISOString())
  return getJson<{ success: boolean; events: CalendarEventRecord[] }>(`${CALENDAR}/events?${params}`)
}

/** Every case a counsellor/admin/guardian is authorised to see, merged into
 * one feed - backs their multi-case calendar views. */
export const fetchOverviewCalendarEvents = (range?: { start?: Date; end?: Date }) => {
  const params = new URLSearchParams()
  if (range?.start) params.set("start", range.start.toISOString())
  if (range?.end) params.set("end", range.end.toISOString())
  const qs = params.toString()
  return getJson<{ success: boolean; events: CalendarEventRecord[] }>(`${CALENDAR}/overview${qs ? `?${qs}` : ""}`)
}

export interface CalendarEventInput {
  aura_id: string
  title: string
  event_type: CalendarEventType
  starts_at: string // ISO
  ends_at?: string | null
  location?: string | null
  notes?: string | null
}

export async function createCalendarEvent(payload: CalendarEventInput) {
  try {
    const res = await fetch(`${CALENDAR}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      credentials: "include",
      body: JSON.stringify(payload),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { success: false, error: data.detail ?? "Could not create the event." }
    return { success: true, ...data }
  } catch {
    return { success: false, error: "Could not reach the server." }
  }
}

export async function updateCalendarEvent(eventId: string, patch: Partial<CalendarEventInput> & { status?: string }) {
  try {
    const res = await fetch(`${CALENDAR}/events/${eventId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeader() },
      credentials: "include",
      body: JSON.stringify(patch),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { success: false, error: data.detail ?? "Could not update the event." }
    return { success: true, ...data }
  } catch {
    return { success: false, error: "Could not reach the server." }
  }
}

export async function deleteCalendarEvent(eventId: string) {
  try {
    const res = await fetch(`${CALENDAR}/events/${eventId}`, {
      method: "DELETE",
      headers: { ...authHeader() },
      credentials: "include",
    })
    return await res.json().catch(() => ({ success: res.ok }))
  } catch {
    return { success: false, error: "Could not reach the server." }
  }
}
