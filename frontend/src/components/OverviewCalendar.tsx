import { useEffect, useMemo, useState } from "react"
import {
  Plus,
  Gavel,
  Stethoscope,
  Heart,
  Landmark,
  Bell,
  StickyNote,
  Users,
  CalendarClock,
  CheckCircle2,
  type LucideIcon,
} from "lucide-react"
import {
  CalendarEventRecord,
  CalendarEventType,
  CalendarEventTypeOption,
  createCalendarEvent,
  fetchCalendarEventTypes,
  fetchOverviewCalendarEvents,
} from "../lib/calendarApi"

const EVENT_ICON: Record<CalendarEventType, LucideIcon> = {
  hearing: Gavel,
  appointment: CalendarClock,
  counselling_session: Heart,
  checkin: CheckCircle2,
  officer_meeting: Users,
  deadline: Bell,
  rehabilitation: Stethoscope,
  compensation: Landmark,
  reminder: Bell,
  personal_note: StickyNote,
}

function startOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

/**
 * The multi-case calendar shared by the Counsellor and Admin dashboards -
 * one agenda merged across every case the signed-in user is authorised to
 * see (backend: GET /api/calendar/overview), rather than four disconnected
 * per-case calendars. A single-case month/week/day grid (AuraCalendar) makes
 * sense for a victim; for a case list this could be dozens of cases long, an
 * agenda grouped by day scales far better than a grid.
 */
export default function OverviewCalendar({
  cases,
  onOpenCase,
  onChanged,
}: {
  /** Known case ids for the "add event" picker - when omitted (e.g. admin,
   * who has no bounded case list client-side), the picker becomes a free-text
   * AURA-ID field instead. */
  cases?: { aura_id: string; label?: string }[]
  onOpenCase?: (auraId: string) => void
  /** Fires after an event is added, so a host dashboard that derives its own
   * data from the same events (e.g. Counsellor's Cases/Follow-up "next
   * event" columns) can refetch and stay in sync. */
  onChanged?: () => void
}) {
  const [events, setEvents] = useState<CalendarEventRecord[] | null>(null)
  const [eventTypes, setEventTypes] = useState<CalendarEventTypeOption[]>([])
  const [caseFilter, setCaseFilter] = useState("")
  const [showForm, setShowForm] = useState(false)
  const [draft, setDraft] = useState({
    aura_id: "",
    title: "",
    event_type: "appointment" as CalendarEventType,
    date: "",
    time: "10:00",
  })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetchCalendarEventTypes().then((r) => setEventTypes(r?.event_types ?? []))
  }, [])

  const load = () => {
    const start = addDays(new Date(), -14)
    fetchOverviewCalendarEvents({ start }).then((r) => setEvents(r?.events ?? []))
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const filtered = useMemo(() => {
    if (!events) return null
    const q = caseFilter.trim().toLowerCase()
    return q ? events.filter((e) => e.aura_id.toLowerCase().includes(q)) : events
  }, [events, caseFilter])

  const grouped = useMemo(() => {
    const map = new Map<string, CalendarEventRecord[]>()
    for (const e of filtered ?? []) {
      const key = startOfDay(new Date(e.starts_at)).toDateString()
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(e)
    }
    return Array.from(map.entries()).sort(
      (a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime()
    )
  }, [filtered])

  const submitDraft = async () => {
    if (!draft.aura_id.trim() || !draft.title.trim() || !draft.date) return
    setSaving(true)
    const startsAt = new Date(`${draft.date}T${draft.time || "00:00"}:00`)
    const res = await createCalendarEvent({
      aura_id: draft.aura_id.trim(),
      title: draft.title.trim(),
      event_type: draft.event_type,
      starts_at: startsAt.toISOString(),
    })
    setSaving(false)
    if (res.success) {
      setShowForm(false)
      setDraft({ aura_id: "", title: "", event_type: "appointment", date: "", time: "10:00" })
      load()
      onChanged?.()
    }
  }

  const caseLabel = (auraId: string) => cases?.find((c) => c.aura_id === auraId)?.label ?? auraId

  return (
    <div className="flex flex-col gap-stack-md">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <input
          value={caseFilter}
          onChange={(e) => setCaseFilter(e.target.value)}
          placeholder="Filter by case AURA-ID…"
          className="rounded-lg border border-outline-variant px-3 py-2 text-sm bg-surface-container-lowest w-64 max-w-full"
        />
        <button
          onClick={() => setShowForm((v) => !v)}
          className="flex items-center gap-1.5 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold shrink-0"
        >
          <Plus size={16} /> Add event
        </button>
      </div>

      {showForm && (
        <div className="rounded-[24px] bg-surface-container-lowest border border-outline-variant p-stack-md card-shadow grid grid-cols-1 md:grid-cols-2 gap-3">
          {cases && cases.length > 0 ? (
            <select
              value={draft.aura_id}
              onChange={(e) => setDraft((d) => ({ ...d, aura_id: e.target.value }))}
              className="rounded-lg border border-outline-variant px-3 py-2 text-sm md:col-span-2 bg-surface-container-lowest"
            >
              <option value="">Select a case…</option>
              {cases.map((c) => (
                <option key={c.aura_id} value={c.aura_id}>
                  {c.label ?? c.aura_id}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={draft.aura_id}
              onChange={(e) => setDraft((d) => ({ ...d, aura_id: e.target.value }))}
              placeholder="Case AURA-ID (e.g. AURA-XXXXXXXXXXXX)"
              className="rounded-lg border border-outline-variant px-3 py-2 text-sm md:col-span-2"
            />
          )}
          <input
            value={draft.title}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            placeholder="What's the event?"
            className="rounded-lg border border-outline-variant px-3 py-2 text-sm md:col-span-2"
          />
          <select
            value={draft.event_type}
            onChange={(e) => setDraft((d) => ({ ...d, event_type: e.target.value as CalendarEventType }))}
            className="rounded-lg border border-outline-variant px-3 py-2 text-sm bg-surface-container-lowest"
          >
            {(eventTypes.length ? eventTypes : [{ value: "appointment", label: "Appointment" }]).map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
          <div className="flex gap-2">
            <input type="date" value={draft.date} onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))} className="flex-1 rounded-lg border border-outline-variant px-3 py-2 text-sm" />
            <input type="time" value={draft.time} onChange={(e) => setDraft((d) => ({ ...d, time: e.target.value }))} className="flex-1 rounded-lg border border-outline-variant px-3 py-2 text-sm" />
          </div>
          <div className="md:col-span-2 flex gap-2">
            <button
              onClick={submitDraft}
              disabled={saving || !draft.aura_id.trim() || !draft.title.trim() || !draft.date}
              className="px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save event"}
            </button>
            <button onClick={() => setShowForm(false)} className="px-4 py-2 rounded-full border border-outline-variant text-on-surface-variant text-label-md">
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="rounded-[24px] bg-surface-container-lowest border border-outline-variant p-stack-md card-shadow">
        {filtered === null ? (
          <p className="text-label-sm text-on-surface-variant">Loading…</p>
        ) : grouped.length === 0 ? (
          <p className="text-label-md text-on-surface-variant">Nothing scheduled.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {grouped.map(([day, dayEvents]) => (
              <div key={day}>
                <p className="text-label-sm font-semibold text-on-surface-variant uppercase tracking-wide mb-1.5">
                  {new Date(day).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
                </p>
                <div className="flex flex-col divide-y divide-outline-variant">
                  {dayEvents.map((e) => {
                    const Icon = EVENT_ICON[e.event_type] ?? CalendarClock
                    const start = new Date(e.starts_at)
                    return (
                      <button
                        key={e.id}
                        onClick={() => onOpenCase?.(e.aura_id)}
                        disabled={!onOpenCase}
                        className="flex items-start gap-3 py-2.5 text-left disabled:cursor-default"
                      >
                        <div className="w-9 h-9 rounded-full bg-primary-container/10 flex items-center justify-center text-primary shrink-0 mt-0.5">
                          <Icon size={16} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="text-label-md font-medium text-on-surface truncate">{e.title}</p>
                            <span className="shrink-0 text-label-sm px-2 py-0.5 rounded-full bg-primary-container/10 text-primary font-semibold">
                              {caseLabel(e.aura_id)}
                            </span>
                          </div>
                          <p className="text-label-sm text-on-surface-variant">
                            {start.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                            {e.location ? ` · ${e.location}` : ""}
                          </p>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
