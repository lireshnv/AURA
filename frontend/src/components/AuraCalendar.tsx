import { useEffect, useMemo, useState } from "react"
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  MapPin,
  Trash2,
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
  deleteCalendarEvent,
  fetchCalendarEventTypes,
  fetchCalendarEvents,
} from "../lib/calendarApi"

type ViewMode = "month" | "week" | "day" | "agenda"

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
function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}
function startOfWeek(d: Date): Date {
  const x = startOfDay(d)
  const day = x.getDay() // 0=Sun
  return addDays(x, -day)
}
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}
function monthGridDays(d: Date): Date[] {
  const first = startOfMonth(d)
  const gridStart = startOfWeek(first)
  return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i))
}

function EventRow({
  event,
  onDelete,
}: {
  event: CalendarEventRecord
  onDelete?: (id: string) => void
}) {
  const Icon = EVENT_ICON[event.event_type] ?? CalendarClock
  const start = new Date(event.starts_at)
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-outline-variant last:border-0">
      <div className="w-9 h-9 rounded-full bg-primary-container/10 flex items-center justify-center text-primary shrink-0 mt-0.5">
        <Icon size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-label-md font-medium text-on-surface truncate">{event.title}</p>
        <p className="text-label-sm text-on-surface-variant">
          {start.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
          {event.location ? ` · ${event.location}` : ""}
        </p>
        {event.notes && <p className="text-label-sm text-on-surface-variant mt-0.5">{event.notes}</p>}
      </div>
      {onDelete && (
        <button
          onClick={() => onDelete(event.id)}
          className="p-1.5 rounded-full hover:bg-error-container/20 text-on-surface-variant hover:text-error shrink-0"
          title="Remove"
        >
          <Trash2 size={14} />
        </button>
      )}
    </div>
  )
}

export default function AuraCalendar({ auraId, readOnly = false }: { auraId: string; readOnly?: boolean }) {
  const [view, setView] = useState<ViewMode>("month")
  const [anchor, setAnchor] = useState(() => new Date())
  const [events, setEvents] = useState<CalendarEventRecord[] | null>(null)
  const [eventTypes, setEventTypes] = useState<CalendarEventTypeOption[]>([])
  const [selectedDay, setSelectedDay] = useState<Date | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [draft, setDraft] = useState({ title: "", event_type: "appointment" as CalendarEventType, date: "", time: "10:00", location: "", notes: "" })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetchCalendarEventTypes().then((r) => setEventTypes(r?.event_types ?? []))
  }, [])

  const load = () => {
    // Load a generous window (6 months back to 6 months ahead) once, rather
    // than refetching on every view/navigation - the dataset per case is
    // small, so this keeps navigation instant.
    const start = addDays(anchor, -186)
    const end = addDays(anchor, 186)
    fetchCalendarEvents(auraId, { start, end }).then((r) => setEvents(r?.events ?? []))
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auraId])

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEventRecord[]>()
    for (const e of events ?? []) {
      const key = startOfDay(new Date(e.starts_at)).toDateString()
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(e)
    }
    return map
  }, [events])

  const onDelete = async (id: string) => {
    await deleteCalendarEvent(id)
    load()
  }

  const submitDraft = async () => {
    if (!draft.title.trim() || !draft.date) return
    setSaving(true)
    const startsAt = new Date(`${draft.date}T${draft.time || "00:00"}:00`)
    const res = await createCalendarEvent({
      aura_id: auraId,
      title: draft.title.trim(),
      event_type: draft.event_type,
      starts_at: startsAt.toISOString(),
      location: draft.location.trim() || undefined,
      notes: draft.notes.trim() || undefined,
    })
    setSaving(false)
    if (res.success) {
      setShowForm(false)
      setDraft({ title: "", event_type: "appointment", date: "", time: "10:00", location: "", notes: "" })
      load()
    }
  }

  const monthLabel = anchor.toLocaleString(undefined, { month: "long", year: "numeric" })
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor), i)), [anchor])
  const agendaEvents = useMemo(
    () => (events ?? []).filter((e) => new Date(e.starts_at) >= startOfDay(new Date())).sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
    [events]
  )

  const shiftAnchor = (dir: 1 | -1) => {
    if (view === "month") setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1))
    else if (view === "week") setAnchor(addDays(anchor, dir * 7))
    else setAnchor(addDays(anchor, dir))
  }

  return (
    <div className="flex flex-col gap-stack-md">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-headline-lg text-on-surface">Calendar</h1>
          <p className="text-body-md text-on-surface-variant mt-1">
            Every important date in one place — hearings, appointments, sessions and reminders.
          </p>
        </div>
        {!readOnly && (
          <button
            onClick={() => setShowForm((v) => !v)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold shrink-0"
          >
            <Plus size={16} /> Add event
          </button>
        )}
      </header>

      {!readOnly && showForm && (
        <div className="rounded-[24px] bg-surface-container-lowest border border-outline-variant p-stack-md card-shadow grid grid-cols-1 md:grid-cols-2 gap-3">
          <input
            value={draft.title}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            placeholder="What's the event?"
            className="rounded-lg border border-outline-variant px-3 py-2 text-sm md:col-span-2 focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <select
            value={draft.event_type}
            onChange={(e) => setDraft((d) => ({ ...d, event_type: e.target.value as CalendarEventType }))}
            className="rounded-lg border border-outline-variant px-3 py-2 text-sm"
          >
            {(eventTypes.length ? eventTypes : [{ value: "appointment", label: "Appointment" }]).map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
          <div className="flex gap-2">
            <input type="date" value={draft.date} onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))} className="flex-1 rounded-lg border border-outline-variant px-3 py-2 text-sm" />
            <input type="time" value={draft.time} onChange={(e) => setDraft((d) => ({ ...d, time: e.target.value }))} className="flex-1 rounded-lg border border-outline-variant px-3 py-2 text-sm" />
          </div>
          <input
            value={draft.location}
            onChange={(e) => setDraft((d) => ({ ...d, location: e.target.value }))}
            placeholder="Location (optional)"
            className="rounded-lg border border-outline-variant px-3 py-2 text-sm"
          />
          <textarea
            value={draft.notes}
            onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
            placeholder="Notes (optional)"
            rows={2}
            className="rounded-lg border border-outline-variant px-3 py-2 text-sm md:col-span-2"
          />
          <div className="md:col-span-2 flex gap-2">
            <button
              onClick={submitDraft}
              disabled={saving || !draft.title.trim() || !draft.date}
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

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex gap-1 rounded-full bg-surface-container-low p-1">
          {(["month", "week", "day", "agenda"] as ViewMode[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-3.5 py-1.5 rounded-full text-label-sm font-semibold capitalize transition-colors ${
                view === v ? "bg-primary text-on-primary" : "text-on-surface-variant hover:text-on-surface"
              }`}
            >
              {v}
            </button>
          ))}
        </div>
        {view !== "agenda" && (
          <div className="flex items-center gap-2">
            <button onClick={() => shiftAnchor(-1)} className="p-1.5 rounded-full hover:bg-surface-container-low text-on-surface-variant">
              <ChevronLeft size={18} />
            </button>
            <span className="text-label-md font-semibold text-on-surface min-w-[140px] text-center">
              {view === "month" ? monthLabel : view === "week" ? `Week of ${weekDays[0].toLocaleDateString()}` : anchor.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
            </span>
            <button onClick={() => shiftAnchor(1)} className="p-1.5 rounded-full hover:bg-surface-container-low text-on-surface-variant">
              <ChevronRight size={18} />
            </button>
            <button onClick={() => setAnchor(new Date())} className="text-label-sm text-primary font-semibold ml-1">
              Today
            </button>
          </div>
        )}
      </div>

      <div className="rounded-[24px] bg-surface-container-lowest border border-outline-variant p-stack-md card-shadow">
        {events === null ? (
          <p className="text-label-sm text-on-surface-variant">Loading…</p>
        ) : view === "month" ? (
          <div className="grid grid-cols-7 gap-1.5">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
              <div key={d} className="text-label-sm text-on-surface-variant text-center font-semibold pb-1">{d}</div>
            ))}
            {monthGridDays(anchor).map((day) => {
              const inMonth = day.getMonth() === anchor.getMonth()
              const dayEvents = eventsByDay.get(day.toDateString()) ?? []
              const isToday = sameDay(day, new Date())
              return (
                <button
                  key={day.toISOString()}
                  onClick={() => setSelectedDay(day)}
                  className={`aspect-square rounded-xl border p-1.5 flex flex-col items-start text-left transition-colors ${
                    selectedDay && sameDay(selectedDay, day) ? "border-primary bg-primary-container/10" : "border-outline-variant hover:bg-surface-container-low"
                  } ${inMonth ? "" : "opacity-40"}`}
                >
                  <span className={`text-label-sm ${isToday ? "w-5 h-5 rounded-full bg-primary text-on-primary flex items-center justify-center" : "text-on-surface"}`}>
                    {day.getDate()}
                  </span>
                  {dayEvents.length > 0 && (
                    <span className="mt-auto text-[10px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary font-semibold">
                      {dayEvents.length}
                    </span>
                  )}
                </button>
              )
            })}
            {selectedDay && (
              <div className="col-span-7 mt-3 pt-3 border-t border-outline-variant">
                <p className="text-label-md font-semibold text-on-surface mb-1">
                  {selectedDay.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
                </p>
                {(eventsByDay.get(selectedDay.toDateString()) ?? []).length === 0 ? (
                  <p className="text-label-sm text-on-surface-variant">Nothing scheduled.</p>
                ) : (
                  (eventsByDay.get(selectedDay.toDateString()) ?? []).map((e) => <EventRow key={e.id} event={e} onDelete={readOnly ? undefined : onDelete} />)
                )}
              </div>
            )}
          </div>
        ) : view === "week" ? (
          <div className="flex flex-col gap-3">
            {weekDays.map((day) => (
              <div key={day.toISOString()}>
                <p className={`text-label-sm font-semibold mb-1 ${sameDay(day, new Date()) ? "text-primary" : "text-on-surface-variant"}`}>
                  {day.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}
                </p>
                {(eventsByDay.get(day.toDateString()) ?? []).length === 0 ? (
                  <p className="text-label-sm text-on-surface-variant pl-1 pb-2 border-b border-outline-variant">Nothing scheduled.</p>
                ) : (
                  (eventsByDay.get(day.toDateString()) ?? []).map((e) => <EventRow key={e.id} event={e} onDelete={readOnly ? undefined : onDelete} />)
                )}
              </div>
            ))}
          </div>
        ) : view === "day" ? (
          (eventsByDay.get(anchor.toDateString()) ?? []).length === 0 ? (
            <p className="text-label-md text-on-surface-variant">Nothing scheduled for this day.</p>
          ) : (
            (eventsByDay.get(anchor.toDateString()) ?? []).map((e) => <EventRow key={e.id} event={e} onDelete={readOnly ? undefined : onDelete} />)
          )
        ) : agendaEvents.length === 0 ? (
          <p className="text-label-md text-on-surface-variant">Nothing coming up.</p>
        ) : (
          agendaEvents.map((e) => <EventRow key={e.id} event={e} onDelete={readOnly ? undefined : onDelete} />)
        )}
      </div>

      <p className="flex items-center gap-1.5 text-label-sm text-on-surface-variant">
        <MapPin size={13} />
        {readOnly
          ? "A read-only view of this case's calendar."
          : "This calendar is shared with your counsellor and case admin, so everyone works from the same dates."}
      </p>
    </div>
  )
}
