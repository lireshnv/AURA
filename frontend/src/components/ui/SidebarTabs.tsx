// Shared in-dashboard left sidebar nav, mirroring AppShell's victim-portal
// sidebar (grouped sections, same active/idle styling) but scoped inside a
// single dashboard page instead of switching AppShell's own Page union -
// Counsellor/Admin/Guardian each still occupy one AppShell page, and this
// renders their internal module list as a real sidebar instead of a
// horizontal tab strip.
export interface SidebarTabItem<K extends string> {
  key: K
  label: string
  icon?: string
  badge?: number
}

export interface SidebarTabGroup<K extends string> {
  heading?: string
  items: SidebarTabItem<K>[]
}

export function SidebarTabs<K extends string>({
  groups,
  active,
  onSelect,
}: {
  groups: SidebarTabGroup<K>[]
  active: K
  onSelect: (key: K) => void
}) {
  return (
    <nav
      aria-label="Dashboard sections"
      className="w-full md:w-56 shrink-0 flex flex-col gap-1 md:sticky md:top-20 md:self-start bg-surface-container-lowest md:bg-transparent border border-outline-variant md:border-0 rounded-2xl p-2 md:p-0"
    >
      {groups.map((group, gi) => (
        <div key={group.heading ?? gi} className={gi === 0 ? "" : "mt-2 pt-2 border-t border-outline-variant/60 md:border-t md:border-outline-variant"}>
          {group.heading && (
            <p className="px-3.5 pt-1 pb-1 text-label-sm font-semibold uppercase tracking-wide text-on-surface-variant/60">
              {group.heading}
            </p>
          )}
          <div className="flex flex-col gap-0.5">
            {group.items.map((item) => (
              <button
                key={item.key}
                onClick={() => onSelect(item.key)}
                aria-current={active === item.key ? "page" : undefined}
                className={`flex items-center justify-between gap-2 px-3.5 py-2.5 rounded-xl text-label-md font-medium transition-colors text-left ${
                  active === item.key
                    ? "bg-primary-container/15 text-primary font-bold"
                    : "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
                }`}
              >
                <span>{item.label}</span>
                {!!item.badge && (
                  <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-full bg-error text-on-error text-[10px] font-bold px-1">
                    {item.badge}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      ))}
    </nav>
  )
}
