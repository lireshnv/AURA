/** Client for the dedicated SOS trigger - a real, recorded event, never a
 * fake/demo confirmation. */
import { API_BASE_URL } from "./api"
import { authHeader } from "./authToken"

export interface SosTriggerResult {
  success: boolean
  id?: string
  timestamp?: string
  has_location?: boolean
  error?: string
}

export interface SosEvent {
  id: string
  timestamp: string
  has_location: boolean
  page: string | null
}

/** SOS status for one victim - authorised for that victim, their assigned
 * counsellor, their linked guardian, or an admin (checked server-side). */
export async function fetchSosHistoryFor(victimAuraId: string): Promise<SosEvent[]> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/sos/history/${victimAuraId}`, {
      headers: { ...authHeader() },
      credentials: "include",
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return []
    const data = await res.json()
    return data.events ?? []
  } catch {
    return []
  }
}

export async function triggerSos(opts: {
  latitude?: number
  longitude?: number
  page?: string
}): Promise<SosTriggerResult> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/sos/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify(opts),
      credentials: "include",
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return { success: false, error: `http_${res.status}` }
    return res.json()
  } catch {
    return { success: false, error: "network_error" }
  }
}

/**
 * Best-effort browser geolocation. Resolves to null on denial, timeout, or
 * an unsupported browser - the SOS flow treats location as optional and
 * never blocks or fakes it.
 */
export function getBestEffortLocation(): Promise<{ latitude: number; longitude: number } | null> {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) {
      resolve(null)
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      () => resolve(null),
      { timeout: 6000, maximumAge: 60000 }
    )
  })
}
