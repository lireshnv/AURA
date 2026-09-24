import { useState } from "react"
import { CalendarEventRecord, updateCalendarEvent } from "../lib/calendarApi"

type SessionFilter = "today" | "upcoming" | "completed" | "missed"

const FILTERS: { key: SessionFilter; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "upcoming", label: "Upcoming" },
  { key: "completed", label: "Completed" },
  { key: "missed", label: "Missed" },
]

const SESSION_TYPES = new Set(["counselling_session", "checkin", "appointment", "officer_meeting"])

/**
 * A dedicated sessions workspace built entirely from real CalendarEvent rows
 * (no separate "session" record exists, or needs to - a session IS a
 * calendar event of the right type). Today/Upcoming/Completed derive from
 * real starts_at + status; "Missed" means "in the past and never marked
 * completed" - a real, honestly-labelled inference, not a guess dressed up
 * as certainty.
 */
export default function SessionsBoard({
  events,
  onOpenCase,
  onChanged,
}: {
  events: CalendarEventRecord[]
  onOpenCase?: (auraId: string) => void
  onChanged?: () => void
}) {
  const [filter, setFilter] = useState<SessionFilter>("today")
  const sessions = events.filter((e) => SESSION_TYPES.has(e.event_type) && e.status !== "cancelled")
  const now = new Date()

  const bucketed = sessions.filter((e) => {
    const d = new Date(e.starts_at)
    if (filter === "today") return d.toDateString() === now.toDateString() && e.status !== "completed"
    if (filter === "upcoming") return d > now && d.toDateString() !== now.toDateString() && e.status !== "completed"
    if (filter === "completed") return e.status === "completed"
    return d < now && e.status === "scheduled" // missed
  }).sort((a, b) => a.starts_at.localeCompare(b.starts_at))

  const markCompleted = async (id: string) => {
    await updateCalendarEvent(id, { status: "completed" })
    onChanged?.()
  }

  return (
    <div className="flex flex-col gap-stack-sm">
      <div className="flex gap-1 rounded-full bg-surface-container-low p-1 w-fit">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`px-3.5 py-1.5 rounded-full text-label-sm font-semibold transition-colors ${
              filter === f.key ? "bg-primary text-on-primary" : "text-on-surface-variant hover:text-on-surface"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {bucketed.length === 0 ? (
        <p className="text-label-md text-on-surface-variant/60 py-6 text-center">Nothing here.</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {bucketed.map((e) => {
            const start = new Date(e.starts_at)
            return (
              <div key={e.id} className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-4">
                <div className="flex items-center justify-between gap-2">
                  <button onClick={() => onOpenCase?.(e.aura_id)} disabled={!onOpenCase} className="text-label-md font-semibold text-on-surface hover:underline disabled:no-underline">
                    {e.aura_id}
                  </button>
                  <span className="text-label-sm text-on-surface-variant capitalize">{e.event_type.replace(/_/g, " ")}</span>
                </div>
                <p className="text-label-md text-on-surface mt-1">{e.title}</p>
                <p className="text-label-sm text-on-surface-variant mt-0.5">
                  {start.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                  {e.location ? ` · ${e.location}` : ""}
                </p>
                {e.notes && <p className="text-label-sm text-on-surface-variant mt-1">{e.notes}</p>}
                {e.status !== "completed" && filter !== "upcoming" && (
                  <button
                    onClick={() => markCompleted(e.id)}
                    className="mt-2 text-label-sm text-primary font-semibold hover:underline"
                  >
                    Mark completed
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
