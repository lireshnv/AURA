import { ReactNode, useState } from "react"
import { LogOut } from "lucide-react"
import SosButton from "./SosButton"

export type Page =
  | "home"
  | "checkin"
  | "analysis"
  | "wellbeing-risk"
  | "insights"
  | "companion"
  | "support"
  | "safety-plan"
  | "history"
  | "profile"
  | "history-profile"
  | "cases"
  | "ivrs-call"
  | "counsellor-call"
  | "admin"
  | "guardian"
export type Role = "victim" | "counsellor" | "admin" | "guardian"

const VICTIM_NAV: { key: Page; label: string; icon: string }[] = [
  { key: "home", label: "Home", icon: "home" },
  { key: "checkin", label: "Check-In", icon: "mood" },
  { key: "companion", label: "Companion", icon: "forum" },
  { key: "insights", label: "Insights", icon: "insights" },
  { key: "support", label: "Support", icon: "volunteer_activism" },
  { key: "history", label: "History", icon: "history" },
  { key: "profile", label: "Profile", icon: "account_circle" },
]

// Counsellors get the case queue, analysis tooling and the AURA Call panel,
// but never the victim's personal home view.
const COUNSELLOR_NAV: { key: Page; label: string; icon: string }[] = [
  { key: "cases", label: "Home", icon: "home" },
  { key: "counsellor-call", label: "AURA Call", icon: "call" },
  { key: "history-profile", label: "History & Profile", icon: "history" },
]

const ADMIN_NAV: { key: Page; label: string; icon: string }[] = [
  { key: "admin", label: "Admin Dashboard", icon: "admin_panel_settings" },
]

const GUARDIAN_NAV: { key: Page; label: string; icon: string }[] = [
  { key: "guardian", label: "Guardian Dashboard", icon: "family_restroom" },
]

const ROLE_PORTAL_LABEL: Record<Role, string> = {
  victim: "Adaptive Unified Resilience & Assistance",
  counsellor: "Counsellor Portal",
  admin: "Administrator Portal",
  guardian: "Guardian Portal",
}

interface Props {
  page: Page
  role: Role
  onNavigate: (page: Page) => void
  backendOnline: boolean | null
  accountLabel?: string | null
  onLogout?: () => void
  children: ReactNode
}

/**
 * Shared shell: header, primary navigation, footer, SOS affordance.
 *
 * Pages are rendered as children so new modules can be added later by
 * extending the Page union and the NAV array - no restructuring of the
 * analysis code required.
 */
const NAV_BY_ROLE: Record<Role, { key: Page; label: string; icon: string }[]> = {
  victim: VICTIM_NAV,
  counsellor: COUNSELLOR_NAV,
  admin: ADMIN_NAV,
  guardian: GUARDIAN_NAV,
}

export default function AppShell({ page, role, onNavigate, backendOnline, accountLabel, onLogout, children }: Props) {
  const nav = NAV_BY_ROLE[role]
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <div className="min-h-screen bg-background text-on-background flex flex-col">
      <header className="bg-surface/80 backdrop-blur-xl border-b border-white/20 sticky top-0 z-40 shadow-sm">
        <div className="flex justify-between items-center px-margin-mobile md:px-margin-desktop py-4 max-w-container-max mx-auto">
          <div className="flex items-center gap-3">
            <span className="text-display-lg-mobile font-bold text-primary tracking-tighter">AURA</span>
            <span className="hidden lg:inline text-label-sm text-on-surface-variant">
              {ROLE_PORTAL_LABEL[role]}
            </span>
          </div>

          <nav className="hidden md:flex gap-4 lg:gap-5 items-center" aria-label="Primary">
            {nav.map(({ key, label, icon }) => {
              const activeTab = page === key
              return (
                <button
                  key={key}
                  onClick={() => onNavigate(key)}
                  aria-current={activeTab ? "page" : undefined}
                  className={`flex items-center gap-1.5 text-label-md whitespace-nowrap transition-colors duration-300 pb-1 ${
                    activeTab
                      ? "text-primary font-bold border-b-2 border-primary"
                      : "text-on-surface-variant font-medium border-b-2 border-transparent hover:text-primary"
                  }`}
                >
                  <span className="material-symbols-outlined text-[16px]">{icon}</span>
                  {label}
                </button>
              )
            })}
          </nav>

          <div className="flex items-center gap-4">
            <span
              className={`w-2 h-2 rounded-full ${
                backendOnline === null ? "bg-outline-variant" : backendOnline ? "bg-secondary" : "bg-error"
              }`}
              title={backendOnline === null ? "Connecting" : backendOnline ? "Service connected" : "Service offline"}
            />
            <div className="relative">
              <button
                onClick={() => setMenuOpen((v) => !v)}
                className="w-10 h-10 rounded-full bg-primary-container/20 border border-outline-variant flex items-center justify-center shrink-0"
                aria-label="Account menu"
              >
                <span className="material-symbols-outlined text-primary text-[20px]">account_circle</span>
              </button>
              {menuOpen && (
                <div className="absolute right-0 mt-2 w-56 bg-surface-container-lowest rounded-xl shadow-lg border border-outline-variant p-3 z-50">
                  {accountLabel && (
                    <p className="text-label-sm text-on-surface-variant truncate mb-2 pb-2 border-b border-outline-variant">
                      {accountLabel}
                    </p>
                  )}
                  <button
                    onClick={() => {
                      setMenuOpen(false)
                      onLogout?.()
                    }}
                    className="w-full flex items-center gap-2 text-label-md text-error hover:bg-error-container/30 rounded-lg px-2 py-1.5"
                  >
                    <LogOut size={14} />
                    Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        <nav className="flex md:hidden gap-1 overflow-x-auto px-margin-mobile pb-2" aria-label="Primary">
          {nav.map(({ key, label, icon }) => {
            const activeTab = page === key
            return (
              <button
                key={key}
                onClick={() => onNavigate(key)}
                aria-current={activeTab ? "page" : undefined}
                className={`flex items-center gap-1.5 px-3 py-2 text-label-md whitespace-nowrap rounded-full transition-colors ${
                  activeTab ? "bg-primary-container/10 text-primary font-bold" : "text-on-surface-variant"
                }`}
              >
                <span className="material-symbols-outlined text-[16px]">{icon}</span>
                {label}
              </button>
            )
          })}
        </nav>
      </header>

      <main className="flex-1 max-w-container-max w-full mx-auto px-margin-mobile md:px-margin-desktop py-stack-md">
        {children}
      </main>

      <SosButton page={page} />

      <footer className="bg-surface-container-low w-full py-stack-md px-margin-mobile md:px-margin-desktop mt-auto">
        <div className="max-w-container-max mx-auto flex flex-col md:flex-row justify-between items-center gap-4">
          <div className="text-center md:text-left">
            <span className="text-primary font-bold text-2xl block mb-1">AURA</span>
            <p className="text-label-sm text-on-surface-variant opacity-80 max-w-md">
              AURA analyses observable signals from facial expression, voice and speech. These are
              indicators for human review — not measurements of inner emotional state, and not a
              clinical or diagnostic assessment. Raw video and audio are never stored.
            </p>
          </div>
          <div className="flex gap-4 text-label-sm text-on-surface-variant">
            <span className="opacity-80">Privacy-first</span>
            <span className="opacity-80">No data sold</span>
            <span className="opacity-80">You control deletion</span>
          </div>
        </div>
      </footer>
    </div>
  )
}
