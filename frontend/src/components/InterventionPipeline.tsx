import { InterventionOverviewRecord } from "../lib/auraApi"

/** Only the statuses the backend actually persists (see
 * POST /api/aura/support/decision) - "Recommended" pathways are computed
 * live per case and aren't stored anywhere queryable across cases, so this
 * pipeline never invents a stage the data can't back. */
const COLUMNS: { key: string; label: string; tone: string }[] = [
  { key: "escalated", label: "Escalated", tone: "border-error/40 bg-error-container/10" },
  { key: "approved", label: "Approved", tone: "border-secondary/40 bg-secondary-container/10" },
  { key: "rejected", label: "Rejected", tone: "border-outline-variant bg-surface-container" },
]

/**
 * The cross-case Interventions pipeline shared by Counsellor and Admin -
 * every recorded support decision, grouped by its real persisted status,
 * backed by GET /api/aura/support/history-overview.
 */
export default function InterventionPipeline({
  interventions,
  onOpenCase,
}: {
  interventions: InterventionOverviewRecord[] | null
  onOpenCase?: (auraId: string) => void
}) {
  if (interventions === null) {
    return <p className="text-label-sm text-on-surface-variant">Loading…</p>
  }
  if (interventions.length === 0) {
    return <p className="text-label-md text-on-surface-variant/60">No intervention decisions recorded yet.</p>
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {COLUMNS.map((col) => {
        const rows = interventions.filter((i) => i.status === col.key)
        return (
          <div key={col.key} className="flex flex-col gap-2">
            <div className="flex items-center justify-between px-1">
              <h4 className="text-label-md font-semibold text-on-surface">{col.label}</h4>
              <span className="text-label-sm text-on-surface-variant">{rows.length}</span>
            </div>
            <div className="flex flex-col gap-2 min-h-[60px]">
              {rows.length === 0 ? (
                <p className="text-label-sm text-on-surface-variant/50 px-1">None</p>
              ) : (
                rows.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => onOpenCase?.(r.aura_id)}
                    disabled={!onOpenCase}
                    className={`text-left rounded-xl border p-3 ${col.tone} disabled:cursor-default`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-label-sm font-semibold text-on-surface truncate">{r.aura_id}</span>
                      <span className="text-label-sm text-on-surface-variant shrink-0">
                        {new Date(r.created_at).toLocaleDateString()}
                      </span>
                    </div>
                    <p className="text-label-md text-on-surface mt-1">{r.pathway}</p>
                    {r.reason && <p className="text-label-sm text-on-surface-variant mt-0.5 line-clamp-2">{r.reason}</p>}
                    {r.decided_by && <p className="text-label-sm text-on-surface-variant/70 mt-1">by {r.decided_by}</p>}
                  </button>
                ))
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
