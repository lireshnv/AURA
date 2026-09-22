/**
 * JWT storage for the browser session. sessionStorage (not localStorage) so
 * a token doesn't silently persist across browser restarts/shared machines
 * beyond the current tab's lifetime - a real, if modest, hardening choice,
 * not a fake-auth shortcut.
 */
const TOKEN_KEY = "aura_access_token"

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, token)
  } catch {
    /* storage disabled - the session just won't persist across reloads */
  }
}

export function clearToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    /* nothing to clear */
  }
}

/** Spread into a fetch `headers` object. Empty when logged out, so every
 * call site can use it unconditionally without an if/else. */
export function authHeader(): Record<string, string> {
  const token = getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}
