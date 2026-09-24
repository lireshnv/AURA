import { useEffect, useState } from "react"
import { Phone, MessageCircle, History, User as UserIcon } from "lucide-react"
import { MyCounsellorRecord, fetchMyCounsellor } from "../lib/auraApi"
import { fetchCallHistory, IvrsCallSummary } from "../lib/ivrsApi"

export default function MyCounsellor({ onOpenCompanion }: { onOpenCompanion: () => void }) {
  const [counsellors, setCounsellors] = useState<MyCounsellorRecord[] | null>(null)
  const [calls, setCalls] = useState<IvrsCallSummary[] | null>(null)

  useEffect(() => {
    fetchMyCounsellor().then((r) => setCounsellors(r?.counsellors ?? []))
    fetchCallHistory().then(setCalls)
  }, [])

  return (
    <div className="flex flex-col gap-stack-md">
      <header>
        <h1 className="text-headline-lg text-on-surface">My Counsellor</h1>
        <p className="text-body-md text-on-surface-variant mt-1">
          The person supporting your case day to day.
        </p>
      </header>

      {counsellors === null ? (
        <p className="text-label-sm text-on-surface-variant">Loading…</p>
      ) : counsellors.length === 0 ? (
        <div className="rounded-[24px] bg-surface-container-lowest border border-outline-variant p-stack-md card-shadow text-center">
          <p className="text-label-md text-on-surface font-medium">No counsellor assigned yet</p>
          <p className="text-label-sm text-on-surface-variant mt-1">
            An admin will assign one to your case soon. You can still talk to Aura in the meantime.
          </p>
        </div>
      ) : (
        counsellors.map((c) => (
          <div key={c.user_id} className="rounded-[24px] bg-surface-container-lowest border border-outline-variant p-stack-md card-shadow flex flex-col md:flex-row md:items-center gap-4">
            <div className="w-16 h-16 rounded-full bg-primary-container/10 flex items-center justify-center text-primary shrink-0">
              <UserIcon size={28} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-headline-md text-on-surface">{c.display_name}</p>
              <p className="text-label-md text-on-surface-variant">
                {c.title ?? "Counsellor"}{c.focus_area ? ` · ${c.focus_area}` : ""}
              </p>
              <p className="text-label-sm text-on-surface-variant mt-1">
                Assigned since {new Date(c.assigned_since).toLocaleDateString()}
              </p>
            </div>
            <button
              onClick={onOpenCompanion}
              className="shrink-0 flex items-center gap-1.5 px-4 py-2.5 rounded-full bg-primary text-on-primary text-label-md font-semibold"
            >
              <MessageCircle size={16} /> Talk to My Counsellor
            </button>
          </div>
        ))
      )}

      <div className="rounded-[24px] bg-surface-container-lowest border border-outline-variant p-stack-md card-shadow">
        <h2 className="text-headline-md text-on-surface mb-3 flex items-center gap-2">
          <History size={18} className="text-primary" /> Previous sessions
        </h2>
        {calls === null ? (
          <p className="text-label-sm text-on-surface-variant">Loading…</p>
        ) : calls.length === 0 ? (
          <p className="text-label-md text-on-surface-variant">No sessions yet.</p>
        ) : (
          <div className="flex flex-col divide-y divide-outline-variant">
            {calls.slice(0, 10).map((call) => (
              <div key={call.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="flex items-center gap-2.5 min-w-0">
                  <Phone size={15} className="text-on-surface-variant shrink-0" />
                  <div className="min-w-0">
                    <p className="text-label-md text-on-surface capitalize truncate">
                      {(call.custom_reason || call.reason_key).replace(/_/g, " ")}
                    </p>
                    <p className="text-label-sm text-on-surface-variant">
                      {new Date(call.started_at).toLocaleString()} · {call.status}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
