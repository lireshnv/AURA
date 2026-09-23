import { ReactNode, useState } from "react"
import { LogOut, Menu, X } from "lucide-react"
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
 * Shared shell: fixed left sidebar (desktop/tablet) or hamburger drawer
 * (mobile), a slim top bar for status/account, and the SOS affordance.
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

function NavButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean
  icon: string
  label: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-label-md font-medium transition-colors ${
        active
          ? "bg-primary-container/15 text-primary font-bold"
          : "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
      }`}
    >
      <span className="material-symbols-outlined text-[18px] shrink-0">{icon}</span>
      {label}
    </button>
  )
}

export default function AppShell({ page, role, onNavigate, backendOnline, accountLabel, onLogout, children }: Props) {
  const nav = NAV_BY_ROLE[role]
  const [menuOpen, setMenuOpen] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  const navigate = (key: Page) => {
    onNavigate(key)
    setMobileNavOpen(false)
  }

  const AccountMenu = (
    <div className="flex items-center gap-3">
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
  )

  return (
    <div className="min-h-screen bg-background text-on-background md:flex">
      {/* --- Sidebar: fixed, desktop/tablet --- */}
      <aside className="hidden md:flex md:flex-col w-56 shrink-0 h-screen sticky top-0 bg-surface-container-lowest border-r border-outline-variant">
        <div className="px-5 py-5 border-b border-outline-variant">
          <span className="text-headline-md font-bold text-primary tracking-tighter">AURA</span>
          <p className="text-label-sm text-on-surface-variant mt-0.5 leading-snug">{ROLE_PORTAL_LABEL[role]}</p>
        </div>
        <nav className="flex-1 overflow-y-auto py-3 px-2.5 flex flex-col gap-1" aria-label="Primary">
          {nav.map(({ key, label, icon }) => (
            <NavButton key={key} active={page === key} icon={icon} label={label} onClick={() => navigate(key)} />
          ))}
        </nav>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        {/* --- Top bar: hamburger + logo on mobile, status/account always --- */}
        <header className="bg-surface/80 backdrop-blur-xl border-b border-outline-variant sticky top-0 z-40 shadow-sm">
          <div className="flex justify-between items-center px-margin-mobile md:px-margin-desktop py-3.5">
            <div className="flex items-center gap-3 md:hidden">
              <button
                onClick={() => setMobileNavOpen(true)}
                aria-label="Open menu"
                className="w-9 h-9 rounded-lg flex items-center justify-center text-on-surface-variant hover:bg-surface-container-high"
              >
                <Menu size={20} />
              </button>
              <span className="text-display-lg-mobile font-bold text-primary tracking-tighter">AURA</span>
            </div>
            <div className="hidden md:block" />
            {AccountMenu}
          </div>
        </header>

        <main className="flex-1 w-full max-w-container-max mx-auto px-margin-mobile md:px-margin-desktop py-stack-md">
          {children}
        </main>

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

      {/* --- Mobile nav drawer --- */}
      {mobileNavOpen && (
        <div className="md:hidden fixed inset-0 z-50">
          <button
            aria-label="Close menu"
            onClick={() => setMobileNavOpen(false)}
            className="absolute inset-0 bg-black/30"
          />
          <div className="absolute left-0 top-0 bottom-0 w-64 bg-surface-container-lowest shadow-xl flex flex-col">
            <div className="flex items-center justify-between px-5 py-5 border-b border-outline-variant">
              <div>
                <span className="text-headline-md font-bold text-primary tracking-tighter">AURA</span>
                <p className="text-label-sm text-on-surface-variant mt-0.5 leading-snug">{ROLE_PORTAL_LABEL[role]}</p>
              </div>
              <button
                onClick={() => setMobileNavOpen(false)}
                aria-label="Close menu"
                className="w-9 h-9 rounded-lg flex items-center justify-center text-on-surface-variant hover:bg-surface-container-high"
              >
                <X size={18} />
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto py-3 px-2.5 flex flex-col gap-1" aria-label="Primary">
              {nav.map(({ key, label, icon }) => (
                <NavButton key={key} active={page === key} icon={icon} label={label} onClick={() => navigate(key)} />
              ))}
            </nav>
          </div>
        </div>
      )}

      <SosButton page={page} />
    </div>
  )
}
