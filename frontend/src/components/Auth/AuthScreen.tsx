import { useState } from "react"
import { ArrowLeft, Loader2 } from "lucide-react"
import {
  AuthUser,
  Role,
  fetchMe,
  forgotPassword,
  googleLoginUrl,
  login,
  logout,
  register,
  requestOtp,
  resetPassword,
  verifyOtp,
} from "../../lib/authApi"

const ROLE_LABEL: Record<Role, string> = {
  victim: "I need support",
  counsellor: "Counsellor",
  admin: "Administrator",
  guardian: "Guardian",
}

// Only victims can self-register (matches the backend's actual rule -
// counsellor/admin/guardian accounts are provisioned by an admin).
const SELF_REGISTER_ROLES: Role[] = ["victim"]

type Mode = "login" | "register" | "otp-request" | "otp-verify" | "forgot-password" | "reset-password"

export default function AuthScreen({
  role,
  onBack,
  onAuthenticated,
  resetToken,
  onResetTokenConsumed,
}: {
  role: Role
  onBack: () => void
  onAuthenticated: (user: AuthUser) => void
  resetToken?: string | null
  onResetTokenConsumed?: () => void
}) {
  const [mode, setMode] = useState<Mode>(resetToken ? "reset-password" : "login")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [otpCode, setOtpCode] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [registered, setRegistered] = useState(false)
  const [resetDone, setResetDone] = useState(false)

  const canRegister = SELF_REGISTER_ROLES.includes(role)

  const finishLogin = async (loggedInRole?: Role) => {
    if (loggedInRole && loggedInRole !== role) {
      await logout()
      setError(`This account is a ${ROLE_LABEL[loggedInRole] ?? loggedInRole} account, not a ${ROLE_LABEL[role]} account.`)
      return
    }
    const user = await fetchMe()
    if (!user) {
      setError("Signed in, but could not load your account. Please try again.")
      return
    }
    onAuthenticated(user)
  }

  const submitPassword = async () => {
    setError(null)
    if (!email.trim() || !password) {
      setError("Enter your email and password.")
      return
    }
    setBusy(true)
    try {
      if (mode === "register") {
        const res = await register(email.trim(), password, displayName.trim() || undefined)
        if (!res.success) {
          setError(res.error ?? "Could not create the account.")
          return
        }
        setRegistered(true)
        setMode("login")
        return
      }
      const res = await login(email.trim(), password)
      if (!res.success) {
        setError(res.error ?? "Could not sign in.")
        return
      }
      await finishLogin(res.role)
    } finally {
      setBusy(false)
    }
  }

  const submitOtpRequest = async () => {
    setError(null)
    setInfo(null)
    if (!email.trim()) {
      setError("Enter your email.")
      return
    }
    setBusy(true)
    try {
      const res = await requestOtp(email.trim())
      setInfo(res.message ?? "If that account exists, a code has been sent.")
      setMode("otp-verify")
    } finally {
      setBusy(false)
    }
  }

  const submitOtpVerify = async () => {
    setError(null)
    if (!otpCode.trim()) {
      setError("Enter the code you received.")
      return
    }
    setBusy(true)
    try {
      const res = await verifyOtp(email.trim(), otpCode.trim())
      if (!res.success) {
        setError(res.error ?? "Invalid or expired code.")
        return
      }
      await finishLogin(res.role)
    } finally {
      setBusy(false)
    }
  }

  const submitForgotPassword = async () => {
    setError(null)
    setInfo(null)
    if (!email.trim()) {
      setError("Enter your email.")
      return
    }
    setBusy(true)
    try {
      const res = await forgotPassword(email.trim())
      setInfo(res.message ?? "If that account exists, a reset link has been sent.")
    } finally {
      setBusy(false)
    }
  }

  const submitResetPassword = async () => {
    setError(null)
    if (!newPassword) {
      setError("Enter a new password.")
      return
    }
    if (!resetToken) {
      setError("This reset link is missing its token.")
      return
    }
    setBusy(true)
    try {
      const res = await resetPassword(resetToken, newPassword)
      if (!res.success) {
        setError(res.error ?? "Could not reset password.")
        return
      }
      setResetDone(true)
      onResetTokenConsumed?.()
      setMode("login")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-label-sm text-on-surface-variant hover:text-on-surface mb-6"
        >
          <ArrowLeft size={14} />
          Choose a different portal
        </button>

        <div className="bg-surface-container-lowest rounded-[24px] card-shadow p-6">
          <h1 className="text-headline-md text-on-surface font-bold mb-1">{ROLE_LABEL[role]}</h1>
          <p className="text-label-md text-on-surface-variant mb-5">
            {mode === "login" && "Sign in to continue."}
            {mode === "register" && "Create your account."}
            {mode === "otp-request" && "Sign in with a one-time code."}
            {mode === "otp-verify" && "Enter the code sent to your account."}
            {mode === "forgot-password" && "We'll send a password reset link to your email."}
            {mode === "reset-password" && "Choose a new password."}
          </p>

          {registered && (
            <div className="rounded-lg bg-secondary-container/20 text-secondary text-label-sm px-3 py-2 mb-4">
              Account created. Sign in below.
            </div>
          )}
          {resetDone && (
            <div className="rounded-lg bg-secondary-container/20 text-secondary text-label-sm px-3 py-2 mb-4">
              Password reset. Sign in with your new password.
            </div>
          )}
          {info && (
            <div className="rounded-lg bg-tertiary-container/20 text-tertiary text-label-sm px-3 py-2 mb-4">
              {info}
            </div>
          )}
          {error && (
            <div className="rounded-lg bg-error-container text-on-error-container text-label-sm px-3 py-2 mb-4">
              {error}
            </div>
          )}

          {(mode === "login" || mode === "register") && (
            <>
              <div className="space-y-3">
                {mode === "register" && (
                  <input
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Display name (optional)"
                    className="w-full rounded-lg border border-outline-variant px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                )}
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Email"
                  autoComplete="email"
                  className="w-full rounded-lg border border-outline-variant px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submitPassword()}
                  placeholder="Password"
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  className="w-full rounded-lg border border-outline-variant px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
                {mode === "register" && (
                  <p className="text-label-sm text-on-surface-variant">
                    At least 12 characters, mixing letters with numbers or symbols.
                  </p>
                )}
              </div>

              <button
                onClick={submitPassword}
                disabled={busy}
                className="w-full mt-5 py-2.5 rounded-full bg-primary hover:bg-primary-fixed-dim text-on-primary text-label-md font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {busy && <Loader2 size={15} className="animate-spin" />}
                {mode === "login" ? "Sign in" : "Create account"}
              </button>

              {mode === "login" && (
                <>
                  <button
                    onClick={() => {
                      setMode("otp-request")
                      setError(null)
                      setInfo(null)
                    }}
                    className="w-full mt-3 text-label-sm text-on-surface-variant text-center hover:text-on-surface"
                  >
                    Sign in with a one-time code instead
                  </button>
                  <button
                    onClick={() => {
                      setMode("forgot-password")
                      setError(null)
                      setInfo(null)
                    }}
                    className="w-full mt-2 text-label-sm text-on-surface-variant text-center hover:text-on-surface"
                  >
                    Forgot password?
                  </button>
                </>
              )}

              <div className="flex items-center gap-3 my-4">
                <div className="h-px flex-1 bg-outline-variant" />
                <span className="text-label-sm text-on-surface-variant">or</span>
                <div className="h-px flex-1 bg-outline-variant" />
              </div>

              <a
                href={googleLoginUrl()}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-full border border-outline-variant text-on-surface text-label-md font-medium hover:bg-surface-container-low"
              >
                <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
                  <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 8 3l6-6C34.6 5.1 29.6 3 24 3 12.4 3 3 12.4 3 24s9.4 21 21 21 21-9.4 21-21c0-1.2-.1-2.4-.4-3.5z" />
                  <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.6 15.9 18.9 13 24 13c3.1 0 5.8 1.1 8 3l6-6C34.6 5.1 29.6 3 24 3c-7.5 0-14 4.2-17.7 10.7z" />
                  <path fill="#4CAF50" d="M24 45c5.5 0 10.4-1.9 14.3-5.1l-6.6-5.6C29.5 36 26.9 37 24 37c-5.3 0-9.7-3.3-11.3-7.9l-6.6 5.1C9.9 40.7 16.4 45 24 45z" />
                  <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.2-4.2 5.6l6.6 5.6C41.5 36.6 45 30.9 45 24c0-1.2-.1-2.4-.4-3.5z" />
                </svg>
                Continue with Google
              </a>

              {canRegister && (
                <button
                  onClick={() => {
                    setMode(mode === "login" ? "register" : "login")
                    setError(null)
                  }}
                  className="w-full mt-3 text-label-sm text-primary text-center"
                >
                  {mode === "login" ? "New here? Create an account" : "Already have an account? Sign in"}
                </button>
              )}
              {!canRegister && (
                <p className="text-label-sm text-on-surface-variant text-center mt-3">
                  {ROLE_LABEL[role]} accounts are created by an administrator.
                </p>
              )}
            </>
          )}

          {mode === "otp-request" && (
            <>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitOtpRequest()}
                placeholder="Email"
                autoComplete="email"
                className="w-full rounded-lg border border-outline-variant px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <button
                onClick={submitOtpRequest}
                disabled={busy}
                className="w-full mt-5 py-2.5 rounded-full bg-primary hover:bg-primary-fixed-dim text-on-primary text-label-md font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {busy && <Loader2 size={15} className="animate-spin" />}
                Send code
              </button>
              <button
                onClick={() => {
                  setMode("login")
                  setError(null)
                  setInfo(null)
                }}
                className="w-full mt-3 text-label-sm text-on-surface-variant text-center hover:text-on-surface"
              >
                Back to password sign-in
              </button>
            </>
          )}

          {mode === "otp-verify" && (
            <>
              <input
                value={otpCode}
                onChange={(e) => setOtpCode(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitOtpVerify()}
                placeholder="6-digit code"
                inputMode="numeric"
                autoComplete="one-time-code"
                className="w-full rounded-lg border border-outline-variant px-3 py-2.5 text-sm text-center tracking-[0.5em] focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <button
                onClick={submitOtpVerify}
                disabled={busy}
                className="w-full mt-5 py-2.5 rounded-full bg-primary hover:bg-primary-fixed-dim text-on-primary text-label-md font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {busy && <Loader2 size={15} className="animate-spin" />}
                Verify code
              </button>
              <button
                onClick={submitOtpRequest}
                disabled={busy}
                className="w-full mt-3 text-label-sm text-primary text-center"
              >
                Resend code
              </button>
            </>
          )}

          {mode === "forgot-password" && (
            <>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitForgotPassword()}
                placeholder="Email"
                autoComplete="email"
                className="w-full rounded-lg border border-outline-variant px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <button
                onClick={submitForgotPassword}
                disabled={busy}
                className="w-full mt-5 py-2.5 rounded-full bg-primary hover:bg-primary-fixed-dim text-on-primary text-label-md font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {busy && <Loader2 size={15} className="animate-spin" />}
                Send reset link
              </button>
              <button
                onClick={() => {
                  setMode("login")
                  setError(null)
                  setInfo(null)
                }}
                className="w-full mt-3 text-label-sm text-on-surface-variant text-center hover:text-on-surface"
              >
                Back to password sign-in
              </button>
            </>
          )}

          {mode === "reset-password" && (
            <>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitResetPassword()}
                placeholder="New password"
                autoComplete="new-password"
                className="w-full rounded-lg border border-outline-variant px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <p className="text-label-sm text-on-surface-variant mt-2">
                At least 12 characters, mixing letters with numbers or symbols.
              </p>
              <button
                onClick={submitResetPassword}
                disabled={busy}
                className="w-full mt-5 py-2.5 rounded-full bg-primary hover:bg-primary-fixed-dim text-on-primary text-label-md font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {busy && <Loader2 size={15} className="animate-spin" />}
                Reset password
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
