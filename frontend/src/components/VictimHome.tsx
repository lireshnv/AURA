import { useEffect, useState } from "react"
import { motion } from "framer-motion"
import {
  Mic,
  CalendarHeart,
  HeartHandshake,
  ShieldAlert,
  Sparkles,
  Activity,
  FolderClock,
  CalendarClock,
  Users,
  Bell,
  MessageCircle,
} from "lucide-react"
import { TwinResponse, fetchTwin, fetchCaseUpdates, fetchMyCounsellor, fetchSupportHistory, InterventionRecord, CaseUpdateRecord, MyCounsellorRecord } from "../lib/auraApi"
import { fetchCalendarEvents, CalendarEventRecord } from "../lib/calendarApi"
import AuraButton from "./ui/AuraButton"
import Pill from "./ui/Pill"
import GlowField from "./ui/GlowField"
import { fadeInUp, scaleIn, staggerContainer, revealOnScroll } from "../lib/motion"

/**
 * Victim-facing home. Answers four questions at a glance - how am I doing,
 * what's happening with my case, what do I need to do today, who can help me
 * - each backed by a real data source (twin, Case Hub updates, shared
 * Calendar, assigned counsellor, support decisions). Nothing here is
 * fabricated: a section with no real data yet says so plainly rather than
 * showing a placeholder that looks like a real value.
 */

const SUPPORT_STATUS: Record<string, { label: string; tone: string }> = {
  high: { label: "Support recommended", tone: "text-[var(--color-glow-amber)]" },
  elevated: { label: "Keep an eye on things", tone: "text-[var(--color-glow-amber)]" },
  low: { label: "All steady", tone: "text-[var(--color-glow-teal)]" },
  insufficient_data: { label: "Still getting to know you", tone: "text-[var(--color-ink-dim)]" },
}

function greeting(): string {
  const h = new Date().getHours()
  if (h < 12) return "Good morning"
  if (h < 18) return "Good afternoon"
  return "Good evening"
}

function ActionCard({
  icon,
  title,
  body,
  onClick,
  emphasis = "default",
}: {
  icon: React.ReactNode
  title: string
  body: string
  onClick?: () => void
  emphasis?: "default" | "primary" | "warning"
}) {
  const classes =
    emphasis === "primary"
      ? "bg-gradient-to-br from-[var(--color-glow-violet)]/25 to-white/[0.03] border-[var(--color-glow-violet)]/30"
      : emphasis === "warning"
      ? "bg-gradient-to-br from-[#ff6b6b]/15 to-white/[0.02] border-[#ff6b6b]/25"
      : "aura-glass"
  const iconTone =
    emphasis === "primary" ? "text-[var(--color-glow-violet)]" : emphasis === "warning" ? "text-[#ff8b8b]" : "text-[var(--color-ink)]"
  return (
    <motion.button
      variants={fadeInUp}
      whileHover={{ y: -4 }}
      onClick={onClick}
      className={`rounded-3xl border p-6 flex flex-col items-center text-center gap-3 transition-shadow ${classes}`}
    >
      <div className="w-12 h-12 rounded-full bg-white/10 flex items-center justify-center">
        <span className={iconTone}>{icon}</span>
      </div>
      <h3 className="text-[16px] font-semibold text-[var(--color-ink)]">{title}</h3>
      <p className="text-[13px] text-[var(--color-ink-dim)] leading-snug">{body}</p>
    </motion.button>
  )
}

function InfoCard({
  icon,
  label,
  title,
  subtitle,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  title: string
  subtitle?: string
  onClick?: () => void
}) {
  const Tag = onClick ? motion.button : motion.div
  return (
    <Tag
      variants={fadeInUp}
      onClick={onClick}
      className={`aura-glass rounded-2xl p-5 flex flex-col gap-2 text-left ${onClick ? "hover:bg-white/[0.07] transition-colors" : ""}`}
    >
      <div className="flex items-center gap-2 text-[var(--color-ink-faint)]">
        {icon}
        <span className="text-[11px] uppercase tracking-wide">{label}</span>
      </div>
      <p className="text-[15px] font-semibold text-[var(--color-ink)] leading-snug">{title}</p>
      {subtitle && <p className="text-[12px] text-[var(--color-ink-dim)] leading-snug">{subtitle}</p>}
    </Tag>
  )
}

export default function VictimHome({
  auraId,
  onOpenAnalysis,
  onOpenCheckin,
  onOpenCompanion,
  onOpenWellbeing,
  onOpenSupport,
  onOpenCase,
  onOpenCalendar,
  onOpenCounsellor,
  onNotSafe,
}: {
  auraId: string
  onOpenAnalysis: () => void
  onOpenCheckin: () => void
  onOpenCompanion: () => void
  onOpenWellbeing: () => void
  onOpenSupport: () => void
  onOpenCase: () => void
  onOpenCalendar: () => void
  onOpenCounsellor: () => void
  onNotSafe: () => void
}) {
  const [data, setData] = useState<TwinResponse | null>(null)
  const [latestUpdate, setLatestUpdate] = useState<CaseUpdateRecord | null | undefined>(undefined)
  const [nextEvent, setNextEvent] = useState<CalendarEventRecord | null | undefined>(undefined)
  const [upcomingAppointment, setUpcomingAppointment] = useState<CalendarEventRecord | null | undefined>(undefined)
  const [counsellors, setCounsellors] = useState<MyCounsellorRecord[] | null>(null)
  const [notification, setNotification] = useState<InterventionRecord | null | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    fetchTwin(auraId).then((d) => !cancelled && setData(d))
    fetchCaseUpdates(auraId).then((r) => !cancelled && setLatestUpdate(r?.updates?.[0] ?? null))
    fetchMyCounsellor().then((r) => !cancelled && setCounsellors(r?.counsellors ?? []))
    fetchSupportHistory(auraId).then((r) => !cancelled && setNotification(r?.interventions?.[0] ?? null))
    fetchCalendarEvents(auraId, { start: new Date() }).then((r) => {
      if (cancelled) return
      const upcoming = (r?.events ?? []).filter((e) => e.status === "scheduled")
      setNextEvent(upcoming[0] ?? null)
      setUpcomingAppointment(
        upcoming.find((e) => ["appointment", "counselling_session", "hearing", "officer_meeting"].includes(e.event_type)) ?? null
      )
    })
    return () => {
      cancelled = true
    }
  }, [auraId])

  const pattern = data?.pattern_label ?? "Still learning your usual pattern"
  const twin = data?.twin
  const supportStatus = SUPPORT_STATUS[twin?.escalation_risk.level ?? "insufficient_data"]
  const showSupportNudge = twin?.escalation_risk.available && twin.escalation_risk.level === "high"

  const formatEvent = (e: CalendarEventRecord) =>
    new Date(e.starts_at).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })

  return (
    <div className="relative -mx-margin-mobile md:-mx-margin-desktop -mt-stack-md px-margin-mobile md:px-margin-desktop pt-stack-md pb-16 overflow-hidden">
      <GlowField />

      <div className="relative z-10 flex flex-col gap-14">
        {/* --- Hero --- */}
        <motion.section
          initial="hidden"
          animate="show"
          variants={staggerContainer(0.08)}
          className="flex flex-col items-center text-center pt-6"
        >
          <motion.div variants={fadeInUp}>
            <Pill dot icon={<Sparkles size={14} />}>
              AURA is here
            </Pill>
          </motion.div>

          <motion.h1
            variants={fadeInUp}
            className="mt-6 text-[34px] leading-[40px] md:text-[56px] md:leading-[60px] tracking-tight font-semibold text-[var(--color-ink)] max-w-2xl"
          >
            {greeting()}. <span className="aura-gradient-text">How are you feeling today?</span>
          </motion.h1>

          <motion.p variants={fadeInUp} className="mt-4 max-w-lg text-[15px] md:text-[16px] text-[var(--color-ink-dim)]">
            Your personal space for reflection and care. Whenever you're ready - there's no rush, and
            you can skip anything.
          </motion.p>

          <motion.div variants={scaleIn} className="relative mt-12 w-40 h-40 md:w-48 md:h-48 flex items-center justify-center">
            <span className="absolute inset-[-18%] rounded-full border border-white/10 animate-aura-float" />
            <div className="absolute inset-0 rounded-full aura-glow-violet blur-2xl animate-aura-breathe" />
            <div className="absolute inset-3 rounded-full bg-gradient-to-br from-[var(--color-glow-violet)] via-[#7c5cff] to-[#4b2fc9] shadow-[0_0_70px_rgba(166,130,255,0.5)] animate-aura-breathe" />
            <div className="absolute inset-[38%] rounded-full bg-white/95" />
          </motion.div>

          <motion.div variants={fadeInUp} className="mt-10">
            <AuraButton onClick={onOpenAnalysis} icon={<Mic size={18} />}>
              Talk to Aura
            </AuraButton>
          </motion.div>
          <motion.button
            variants={fadeInUp}
            onClick={onOpenCompanion}
            className="mt-3 inline-flex items-center gap-1.5 text-[13px] text-[var(--color-ink-faint)] hover:text-[var(--color-ink-dim)] transition-colors"
          >
            <MessageCircle size={13} />
            Prefer to type? Message Aura instead
          </motion.button>
        </motion.section>

        {/* --- How am I doing / what's happening / who can help --- */}
        <motion.section
          initial="hidden"
          whileInView="show"
          viewport={revealOnScroll}
          variants={staggerContainer(0.06)}
          className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-4xl mx-auto w-full"
        >
          <InfoCard
            icon={<Activity size={14} />}
            label="Current wellbeing"
            title={pattern}
            onClick={onOpenWellbeing}
          />
          <InfoCard
            icon={<FolderClock size={14} />}
            label="Latest case update"
            title={latestUpdate === undefined ? "Loading…" : latestUpdate ? latestUpdate.title : "No updates yet"}
            subtitle={latestUpdate ? new Date(latestUpdate.created_at).toLocaleDateString() : undefined}
            onClick={onOpenCase}
          />
          <InfoCard
            icon={<Users size={14} />}
            label="My counsellor"
            title={counsellors === null ? "Loading…" : counsellors.length > 0 ? counsellors[0].display_name : "Not yet assigned"}
            subtitle={counsellors && counsellors.length > 0 ? counsellors[0].title ?? "Available for you" : undefined}
            onClick={onOpenCounsellor}
          />
          <InfoCard
            icon={<CalendarClock size={14} />}
            label="Next important date"
            title={nextEvent === undefined ? "Loading…" : nextEvent ? nextEvent.title : "Nothing scheduled"}
            subtitle={nextEvent ? formatEvent(nextEvent) : undefined}
            onClick={onOpenCalendar}
          />
          <InfoCard
            icon={<CalendarHeart size={14} />}
            label="Upcoming appointment"
            title={upcomingAppointment === undefined ? "Loading…" : upcomingAppointment ? upcomingAppointment.title : "None scheduled"}
            subtitle={upcomingAppointment ? formatEvent(upcomingAppointment) : undefined}
            onClick={onOpenCalendar}
          />
          <InfoCard
            icon={<Bell size={14} />}
            label="Recent notification"
            title={notification === undefined ? "Loading…" : notification ? notification.pathway : "Nothing new"}
            subtitle={notification ? `Status: ${notification.status.replace(/_/g, " ")}` : undefined}
            onClick={onOpenCase}
          />
        </motion.section>

        {/* --- Quick help --- */}
        <motion.section
          initial="hidden"
          whileInView="show"
          viewport={revealOnScroll}
          variants={staggerContainer(0.06)}
          className="grid grid-cols-2 lg:grid-cols-3 gap-4 max-w-4xl mx-auto w-full"
        >
          <ActionCard
            icon={<CalendarHeart size={22} />}
            title="Check in"
            body="A minute to log how you're actually doing."
            onClick={onOpenCheckin}
          />
          <ActionCard
            icon={<HeartHandshake size={22} />}
            title="I need help"
            body="Counselling, legal, medical or protection support."
            onClick={onOpenSupport}
          />
          <ActionCard
            emphasis="warning"
            icon={<ShieldAlert size={22} />}
            title="I'm not feeling safe"
            body="Send an SOS alert with your location, right now."
            onClick={onNotSafe}
          />
        </motion.section>

        {showSupportNudge && (
          <motion.section
            initial="hidden"
            whileInView="show"
            viewport={revealOnScroll}
            variants={fadeInUp}
            className="max-w-4xl mx-auto w-full rounded-2xl border border-[var(--color-glow-amber)]/25 bg-[var(--color-glow-amber)]/[0.06] p-5 flex flex-col md:flex-row items-center justify-between gap-4"
          >
            <div className="text-center md:text-left">
              <p className="text-[15px] font-semibold text-[var(--color-ink)]">Things have seemed a bit harder lately</p>
              <p className="text-[13px] text-[var(--color-ink-dim)] mt-1">
                That's okay - support status: {supportStatus.label.toLowerCase()}.
              </p>
            </div>
            <AuraButton size="md" onClick={onOpenSupport}>
              Get support
            </AuraButton>
          </motion.section>
        )}

        <p className="text-center text-[13px] text-[var(--color-ink-faint)] max-w-md mx-auto">
          AURA provides supportive guidance and does not replace professional care.
        </p>
      </div>
    </div>
  )
}
