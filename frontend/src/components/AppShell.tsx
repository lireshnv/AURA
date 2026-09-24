import { ReactNode, useState } from "react"
import { ChevronDown, LogOut, Menu, X } from "lucide-react"
import SosButton from "./SosButton"

export type Page =
  | "home"
  | "case-hub"
  | "calendar"
  | "my-counsellor"
  | "checkin"
  | "analysis"
  | "wellbeing-risk"
  | "insights"
  | "companion"
  | "support"
  | "safety-plan"
  | "history"
  | "profile"
  | "cases"
  | "ivrs-call"
  | "admin"
  | "guardian"
export type Role = "victim" | "counsellor" | "admin" | "guardian"

// The spec's exact victim IA: Home, My Case, Talk to Aura, My Companion,
// Check-In, Calendar, My Counsellor, Support, Profile as first-class nav -
// everything else (Wellbeing detail, Safety Plan) folds into "More".
const VICTIM_NAV: { key: Page; label: string; icon: string }[] = [
  { key: "home", label: "Home", icon: "home" },
  { key: "case-hub", label: "My Case", icon: "folder_shared" },
  { key: "analysis", label: "Talk to Aura", icon: "graphic_eq" },
  { key: "companion", label: "My Companion", icon: "forum" },
  { key: "checkin", label: "Check-In", icon: "mood" },
  { key: "calendar", label: "Calendar", icon: "calendar_month" },
  { key: "my-counsellor", label: "My Counsellor", icon: "psychology" },
  { key: "support", label: "Support", icon: "volunteer_activism" },
  { key: "profile", label: "Profile", icon: "account_circle" },
]

const VICTIM_NAV_MORE: { key: Page; label: string; icon: string }[] = [
  { key: "insights", label: "Wellbeing", icon: "insights" },
  { key: "safety-plan", label: "Safety Plan", icon: "shield" },
]

// Counsellors get a single AppShell entry - AURA Call and History & Profile
// live inside CounsellorDashboard's own sidebar now (see its TAB_GROUPS),
// so there's one sidebar instead of two stacked ones.
const COUNSELLOR_NAV: { key: Page; label: string; icon: string }[] = [
  { key: "cases", label: "Home", icon: "home" },
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

export interface SidebarGroupItem {
  key: string
  label: string
  icon: string
  badge?: number
}
export interface SidebarGroup {
  heading?: string
  items: SidebarGroupItem[]
}

interface Props {
  page: Page
  role: Role
  onNavigate: (page: Page) => void
  backendOnline: boolean | null
  accountLabel?: string | null
  onLogout?: () => void
  sosTrigger?: number
  /** Swaps the shell chrome (sidebar/topbar/footer) to the dark Aura
   * Cinematic skin for a specific page's content, without touching the MD3
   * light theme every other page still uses. */
  cinematic?: boolean
  /** When provided, replaces the normal flat NAV_BY_ROLE list with a
   * grouped, sectioned menu (headings + items) rendered directly in this
   * one sidebar - used by Counsellor/Admin/Guardian so every module lives
   * in a single sidebar instead of an inner page rendering a second one. */
  sidebarGroups?: SidebarGroup[]
  sidebarActive?: string
  onSidebarNavigate?: (key: string) => void
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

const NAV_MORE_BY_ROLE: Record<Role, { key: Page; label: string; icon: string }[]> = {
  victim: VICTIM_NAV_MORE,
  counsellor: [],
  admin: [],
  guardian: [],
}

function NavButton({
  active,
  icon,
  label,
  onClick,
  cinematic,
}: {
  active: boolean
  icon: string
  label: string
  onClick: () => void
  cinematic?: boolean
}) {
  const activeClasses = cinematic
    ? "bg-white/10 text-[var(--color-ink)] font-bold"
    : "bg-primary-container/15 text-primary font-bold"
  const idleClasses = cinematic
    ? "text-[var(--color-ink-dim)] hover:bg-white/5 hover:text-[var(--color-ink)]"
    : "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-label-md font-medium transition-colors ${
        active ? activeClasses : idleClasses
      }`}
    >
      <span aria-hidden="true" className="material-symbols-outlined text-[18px] shrink-0">{icon}</span>
      {label}
    </button>
  )
}

export default function AppShell({
  page,
  role,
  onNavigate,
  backendOnline,
  accountLabel,
  onLogout,
  sosTrigger,
  cinematic,
  sidebarGroups,
  sidebarActive,
  onSidebarNavigate,
  children,
}: Props) {
  const nav = NAV_BY_ROLE[role]
  const navMore = NAV_MORE_BY_ROLE[role]
  const [menuOpen, setMenuOpen] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  // Starts open when the active page actually lives under "More", so landing
  // on e.g. Wellbeing from a deep link doesn't hide its own nav entry.
  const [moreOpen, setMoreOpen] = useState(() => navMore.some((item) => item.key === page))

  const navigate = (key: Page) => {
    onNavigate(key)
    setMobileNavOpen(false)
  }

  const wordmarkClass = cinematic ? "text-[var(--color-ink)]" : "text-primary"
  const subLabelClass = cinematic ? "text-[var(--color-ink-faint)]" : "text-on-surface-variant"

  const moreSection =
    navMore.length === 0 ? null : (
      <div className="mt-1 pt-1">
        <button
          onClick={() => setMoreOpen((v) => !v)}
          className={`w-full flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl text-label-md font-medium transition-colors ${
            cinematic
              ? "text-[var(--color-ink-faint)] hover:bg-white/5 hover:text-[var(--color-ink-dim)]"
              : "text-on-surface-variant hover:bg-surface-container-high"
          }`}
          aria-expanded={moreOpen}
        >
          <span className="flex items-center gap-3">
            <span className="material-symbols-outlined text-[18px] shrink-0">more_horiz</span>
            More
          </span>
          <ChevronDown size={14} className={`transition-transform ${moreOpen ? "rotate-180" : ""}`} />
        </button>
        {moreOpen && (
          <div className="mt-1 flex flex-col gap-1">
            {navMore.map(({ key, label, icon }) => (
              <NavButton key={key} active={page === key} icon={icon} label={label} onClick={() => navigate(key)} cinematic={cinematic} />
            ))}
          </div>
        )}
      </div>
    )

  const groupedNav = sidebarGroups && (
    <div className="flex flex-col gap-1">
      {sidebarGroups.map((group, gi) => (
        <div key={group.heading ?? gi} className={gi === 0 ? "" : "mt-2 pt-2 border-t " + (cinematic ? "border-[var(--color-hairline)]" : "border-outline-variant")}>
          {group.heading && (
            <p
              className={`px-3.5 pt-1 pb-1 text-label-sm font-semibold uppercase tracking-wide ${
                cinematic ? "text-[var(--color-ink-faint)]" : "text-on-surface-variant/60"
              }`}
            >
              {group.heading}
            </p>
          )}
          <div className="flex flex-col gap-1">
            {group.items.map(({ key, label, icon, badge }) => (
              <div key={key} className="relative">
                <NavButton
                  active={sidebarActive === key}
                  icon={icon}
                  label={label}
                  onClick={() => {
                    onSidebarNavigate?.(key)
                    setMobileNavOpen(false)
                  }}
                  cinematic={cinematic}
                />
                {!!badge && (
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-full bg-error text-on-error text-[10px] font-bold px-1">
                    {badge}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )

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
          className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 border ${
            cinematic ? "bg-white/10 border-white/10" : "bg-primary-container/20 border-outline-variant"
          }`}
          aria-label="Account menu"
        >
          <span className={`material-symbols-outlined text-[20px] ${cinematic ? "text-[var(--color-ink)]" : "text-primary"}`}>
            account_circle
          </span>
        </button>
        {menuOpen && (
          <div
            className={`absolute right-0 mt-2 w-56 rounded-xl shadow-lg p-3 z-50 border ${
              cinematic
                ? "aura-glass-strong border-[var(--color-hairline)]"
                : "bg-surface-container-lowest border-outline-variant"
            }`}
          >
            {accountLabel && (
              <p
                className={`text-label-sm truncate mb-2 pb-2 border-b ${
                  cinematic ? "text-[var(--color-ink-dim)] border-[var(--color-hairline)]" : "text-on-surface-variant border-outline-variant"
                }`}
              >
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
    <div className={`min-h-screen md:flex ${cinematic ? "aura-cinematic" : "bg-background text-on-background"}`}>
      {/* --- Sidebar: fixed, desktop/tablet --- */}
      <aside
        className={`hidden md:flex md:flex-col w-56 shrink-0 h-screen sticky top-0 border-r ${
          cinematic ? "bg-[var(--color-void-raised)] border-[var(--color-hairline)]" : "bg-surface-container-lowest border-outline-variant"
        }`}
      >
        <div className={`px-5 py-5 border-b ${cinematic ? "border-[var(--color-hairline)]" : "border-outline-variant"}`}>
          <span className={`text-headline-md font-bold tracking-tighter ${wordmarkClass}`}>AURA</span>
          <p className={`text-label-sm mt-0.5 leading-snug ${subLabelClass}`}>{ROLE_PORTAL_LABEL[role]}</p>
        </div>
        <nav className="flex-1 overflow-y-auto py-3 px-2.5 flex flex-col gap-1" aria-label="Primary">
          {sidebarGroups ? (
            groupedNav
          ) : (
            <>
              {nav.map(({ key, label, icon }) => (
                <NavButton key={key} active={page === key} icon={icon} label={label} onClick={() => navigate(key)} cinematic={cinematic} />
              ))}
              {moreSection}
            </>
          )}
        </nav>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        {/* --- Top bar: hamburger + logo on mobile, status/account always --- */}
        <header
          className={`backdrop-blur-xl border-b sticky top-0 z-40 shadow-sm ${
            cinematic ? "bg-[var(--color-void)]/80 border-[var(--color-hairline)]" : "bg-surface/80 border-outline-variant"
          }`}
        >
          <div className="flex justify-between items-center px-margin-mobile md:px-margin-desktop py-3.5">
            <div className="flex items-center gap-3 md:hidden">
              <button
                onClick={() => setMobileNavOpen(true)}
                aria-label="Open menu"
                className={`w-9 h-9 rounded-lg flex items-center justify-center ${
                  cinematic ? "text-[var(--color-ink-dim)] hover:bg-white/5" : "text-on-surface-variant hover:bg-surface-container-high"
                }`}
              >
                <Menu size={20} />
              </button>
              <span className={`text-display-lg-mobile font-bold tracking-tighter ${wordmarkClass}`}>AURA</span>
            </div>
            <div className="hidden md:block" />
            {AccountMenu}
          </div>
        </header>

        <main className="flex-1 w-full max-w-container-max mx-auto px-margin-mobile md:px-margin-desktop py-stack-md">
          {children}
        </main>

        <footer
          className={`w-full py-stack-md px-margin-mobile md:px-margin-desktop mt-auto ${
            cinematic ? "bg-[var(--color-void-raised)] border-t border-[var(--color-hairline)]" : "bg-surface-container-low"
          }`}
        >
          <div className="max-w-container-max mx-auto flex flex-col md:flex-row justify-between items-center gap-4">
            <div className="text-center md:text-left">
              <span className={`font-bold text-2xl block mb-1 ${wordmarkClass}`}>AURA</span>
              <p className={`text-label-sm opacity-80 max-w-md ${cinematic ? "text-[var(--color-ink-dim)]" : "text-on-surface-variant"}`}>
                AURA analyses observable signals from facial expression, voice and speech. These are
                indicators for human review — not measurements of inner emotional state, and not a
                clinical or diagnostic assessment. Raw video and audio are never stored.
              </p>
            </div>
            <div className={`flex gap-4 text-label-sm ${cinematic ? "text-[var(--color-ink-dim)]" : "text-on-surface-variant"}`}>
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
          <div
            className={`absolute left-0 top-0 bottom-0 w-64 shadow-xl flex flex-col ${
              cinematic ? "bg-[var(--color-void-raised)]" : "bg-surface-container-lowest"
            }`}
          >
            <div className={`flex items-center justify-between px-5 py-5 border-b ${cinematic ? "border-[var(--color-hairline)]" : "border-outline-variant"}`}>
              <div>
                <span className={`text-headline-md font-bold tracking-tighter ${wordmarkClass}`}>AURA</span>
                <p className={`text-label-sm mt-0.5 leading-snug ${subLabelClass}`}>{ROLE_PORTAL_LABEL[role]}</p>
              </div>
              <button
                onClick={() => setMobileNavOpen(false)}
                aria-label="Close menu"
                className={`w-9 h-9 rounded-lg flex items-center justify-center ${
                  cinematic ? "text-[var(--color-ink-dim)] hover:bg-white/5" : "text-on-surface-variant hover:bg-surface-container-high"
                }`}
              >
                <X size={18} />
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto py-3 px-2.5 flex flex-col gap-1" aria-label="Primary">
              {sidebarGroups ? (
                groupedNav
              ) : (
                <>
                  {nav.map(({ key, label, icon }) => (
                    <NavButton key={key} active={page === key} icon={icon} label={label} onClick={() => navigate(key)} cinematic={cinematic} />
                  ))}
                  {moreSection}
                </>
              )}
            </nav>
          </div>
        </div>
      )}

      <SosButton page={page} externalTrigger={sosTrigger} />
    </div>
  )
}
