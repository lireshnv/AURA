/** Client for the real JWT auth system (backend/app/api/auth_routes.py) -
 * register/login/logout, admin provisioning, and counsellor assignments.
 * No mock/demo login path exists here; every call hits the real backend. */
import { API_BASE_URL } from "./api"
import { authHeader, clearToken, setToken } from "./authToken"

const AUTH = `${API_BASE_URL}/api/auth`

export type Role = "victim" | "counsellor" | "admin" | "guardian"

export interface AuthUser {
  id: string
  email: string
  aura_id: string
  role: Role
  display_name?: string | null
  mfa_enabled: boolean
  onboarding_complete: boolean
}

export interface AuthResult {
  success: boolean
  role?: Role
  aura_id?: string
  error?: string
}

async function parseError(res: Response): Promise<string> {
  try {
    const data = await res.json()
    const detail = data?.detail
    if (typeof detail === "string") return detail
    if (detail?.password) return detail.password.join(" ")
    return "Something went wrong. Please try again."
  } catch {
    return "Something went wrong. Please try again."
  }
}

export async function register(
  email: string,
  password: string,
  displayName?: string
): Promise<AuthResult> {
  try {
    const res = await fetch(`${AUTH}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, display_name: displayName }),
    })
    if (!res.ok) return { success: false, error: await parseError(res) }
    return { success: true }
  } catch {
    return { success: false, error: "Could not reach the server." }
  }
}

export async function login(email: string, password: string): Promise<AuthResult> {
  try {
    const res = await fetch(`${AUTH}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
      credentials: "include", // also receives the httpOnly session cookie
    })
    if (!res.ok) return { success: false, error: await parseError(res) }
    const data = await res.json()
    setToken(data.access_token)
    return { success: true, role: data.role, aura_id: data.aura_id }
  } catch {
    return { success: false, error: "Could not reach the server." }
  }
}

/** Redirect target for "Continue with Google" - a full-page navigation, not
 * a fetch, since the OAuth handshake itself happens on Google's own domain. */
export function googleLoginUrl(): string {
  return `${AUTH}/google/login`
}

export async function requestOtp(email: string): Promise<{ success: boolean; message?: string }> {
  try {
    const res = await fetch(`${AUTH}/otp/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    })
    const data = await res.json().catch(() => ({}))
    return { success: res.ok && data.success, message: data.message }
  } catch {
    return { success: false, message: "Could not reach the server." }
  }
}

export async function verifyOtp(email: string, code: string): Promise<AuthResult> {
  try {
    const res = await fetch(`${AUTH}/otp/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, code }),
      credentials: "include",
    })
    if (!res.ok) return { success: false, error: await parseError(res) }
    const data = await res.json()
    setToken(data.access_token)
    return { success: true, role: data.role, aura_id: data.aura_id }
  } catch {
    return { success: false, error: "Could not reach the server." }
  }
}

export async function forgotPassword(email: string): Promise<{ success: boolean; message?: string }> {
  try {
    const res = await fetch(`${AUTH}/password/forgot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    })
    const data = await res.json().catch(() => ({}))
    return { success: res.ok && data.success, message: data.message }
  } catch {
    return { success: false, message: "Could not reach the server." }
  }
}

export async function resetPassword(
  token: string,
  newPassword: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(`${AUTH}/password/reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, new_password: newPassword }),
    })
    if (!res.ok) return { success: false, error: await parseError(res) }
    return { success: true }
  } catch {
    return { success: false, error: "Could not reach the server." }
  }
}

export async function logout(): Promise<void> {
  try {
    await fetch(`${AUTH}/logout`, {
      method: "POST",
      headers: { ...authHeader() },
      credentials: "include",
    })
  } catch {
    /* best-effort - the session row will simply expire on its own */
  } finally {
    clearToken()
  }
}

export async function fetchMe(): Promise<AuthUser | null> {
  // No early return on a missing bearer token: a Google sign-in carries no
  // token into sessionStorage at all (it's a page redirect, not a fetch) -
  // only the httpOnly cookie proves that session, so this must always ask.
  try {
    const res = await fetch(`${AUTH}/me`, { headers: { ...authHeader() }, credentials: "include" })
    if (!res.ok) {
      if (res.status === 401) clearToken()
      return null
    }
    const data = await res.json()
    return data.user as AuthUser
  } catch {
    return null
  }
}

export async function submitOnboarding(responses: Record<string, string>): Promise<boolean> {
  try {
    const res = await fetch(`${AUTH}/onboarding`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({ responses }),
    })
    return res.ok
  } catch {
    return false
  }
}

// --- Admin: provisioning + assignments --------------------------------

export interface AdminUser {
  id: string
  email: string
  aura_id: string
  role: Role
  display_name?: string | null
  is_active: boolean
  last_login_at: string | null
  created_at: string
}

export async function adminCreateUser(
  email: string,
  password: string,
  role: "counsellor" | "admin" | "guardian",
  displayName?: string
): Promise<AuthResult> {
  try {
    const res = await fetch(`${AUTH}/admin/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({ email, password, role, display_name: displayName }),
    })
    if (!res.ok) return { success: false, error: await parseError(res) }
    return { success: true }
  } catch {
    return { success: false, error: "Could not reach the server." }
  }
}

export async function adminListUsers(): Promise<AdminUser[]> {
  try {
    const res = await fetch(`${AUTH}/admin/users`, { headers: { ...authHeader() } })
    if (!res.ok) return []
    const data = await res.json()
    return data.users ?? []
  } catch {
    return []
  }
}

export async function adminUpdateUser(
  userId: string,
  changes: { role?: Role; is_active?: boolean }
): Promise<boolean> {
  try {
    const res = await fetch(`${AUTH}/admin/users/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify(changes),
    })
    return res.ok
  } catch {
    return false
  }
}

export interface Assignment {
  id: string
  counsellor_user_id: string
  victim_aura_id: string
  active: boolean
  assigned_at: string
}

export async function adminListAssignments(): Promise<Assignment[]> {
  try {
    const res = await fetch(`${AUTH}/admin/assignments`, { headers: { ...authHeader() } })
    if (!res.ok) return []
    const data = await res.json()
    return data.assignments ?? []
  } catch {
    return []
  }
}

export async function adminCreateAssignment(
  counsellorUserId: string,
  victimAuraId: string
): Promise<boolean> {
  try {
    const res = await fetch(`${AUTH}/admin/assignments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({ counsellor_user_id: counsellorUserId, victim_aura_id: victimAuraId }),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function adminRevokeAssignment(assignmentId: string): Promise<boolean> {
  try {
    const res = await fetch(`${AUTH}/admin/assignments/${assignmentId}`, {
      method: "DELETE",
      headers: { ...authHeader() },
    })
    return res.ok
  } catch {
    return false
  }
}

export async function fetchMyVictims(): Promise<string[]> {
  try {
    const res = await fetch(`${AUTH}/my-victims`, { headers: { ...authHeader() } })
    if (!res.ok) return []
    const data = await res.json()
    return data.aura_ids ?? []
  } catch {
    return []
  }
}

// --- Guardian links -----------------------------------------------------

export interface GuardianLink {
  id: string
  guardian_user_id: string
  victim_aura_id: string
  active: boolean
  assigned_at: string
}

export async function adminListGuardianLinks(): Promise<GuardianLink[]> {
  try {
    const res = await fetch(`${AUTH}/admin/guardian-links`, { headers: { ...authHeader() } })
    if (!res.ok) return []
    const data = await res.json()
    return data.links ?? []
  } catch {
    return []
  }
}

export async function adminCreateGuardianLink(
  guardianUserId: string,
  victimAuraId: string
): Promise<boolean> {
  try {
    const res = await fetch(`${AUTH}/admin/guardian-links`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({ guardian_user_id: guardianUserId, victim_aura_id: victimAuraId }),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function adminRevokeGuardianLink(linkId: string): Promise<boolean> {
  try {
    const res = await fetch(`${AUTH}/admin/guardian-links/${linkId}`, {
      method: "DELETE",
      headers: { ...authHeader() },
    })
    return res.ok
  } catch {
    return false
  }
}

export async function fetchMyLinkedVictims(): Promise<string[]> {
  try {
    const res = await fetch(`${AUTH}/my-linked-victims`, { headers: { ...authHeader() } })
    if (!res.ok) return []
    const data = await res.json()
    return data.aura_ids ?? []
  } catch {
    return []
  }
}
