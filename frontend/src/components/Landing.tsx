import { useRef } from "react"
import { motion, useScroll, useTransform } from "framer-motion"
import {
  Mic,
  ShieldCheck,
  HeartHandshake,
  LineChart,
  Lock,
  MessagesSquare,
  Users,
  Sparkles,
  ArrowRight,
  FolderLock,
  Eye,
  KeyRound,
  Stethoscope,
  CalendarClock,
  FolderKanban,
  Radio,
} from "lucide-react"
import AuraButton from "./ui/AuraButton"
import Pill from "./ui/Pill"
import GlowField from "./ui/GlowField"
import FloatCard from "./ui/FloatCard"
import { fadeInUp, staggerContainer, revealOnScroll } from "../lib/motion"
import { Role } from "../lib/authApi"

const ROLES: {
  role: Role
  title: string
  body: string
  icon: typeof HeartHandshake
  cta: string
  glow: string
}[] = [
  {
    role: "victim",
    title: "Survivor",
    body: "One place to talk, track how you're doing, see your case and reach the people supporting you.",
    icon: HeartHandshake,
    cta: "Enter as a survivor",
    glow: "var(--color-glow-violet)",
  },
  {
    role: "counsellor",
    title: "Counsellor",
    body: "Your caseload, wellbeing trends and session history in one queue - connected to the same case record the victim sees.",
    icon: Stethoscope,
    cta: "Enter as a counsellor",
    glow: "var(--color-glow-teal)",
  },
  {
    role: "admin",
    title: "Officer / Admin",
    body: "Case oversight, alerts and district-level monitoring, drilling into the exact same Case Hub - never a separate record.",
    icon: ShieldCheck,
    cta: "Enter as an administrator",
    glow: "var(--color-glow-amber)",
  },
  {
    role: "guardian",
    title: "Guardian",
    body: "A consented, read-only window into wellbeing, updates and the calendar - only what you've been given access to.",
    icon: Users,
    cta: "Enter as a guardian",
    glow: "var(--color-glow-violet)",
  },
]

const CONNECTED = [
  { icon: FolderKanban, title: "One Case Hub", body: "Every role reads and writes the same case - complaint through investigation, trial, rehabilitation and compensation." },
  { icon: CalendarClock, title: "One Calendar", body: "Hearings, sessions, check-ins and reminders live in a single shared calendar, not four disconnected ones." },
  { icon: Radio, title: "One thread of updates", body: "A stage change, a new document or a counsellor's note appears the moment it happens, for everyone authorised to see it." },
]

const HELPS = [
  {
    icon: MessagesSquare,
    title: "Talk, in your own words",
    body: "Aura listens - by voice or text - without judgement, without a script, and without needing you to explain everything at once.",
  },
  {
    icon: LineChart,
    title: "Understands how you're doing",
    body: "Gentle patterns over time, shown back to you in plain language. Never a diagnosis, never a score you have to decode.",
  },
  {
    icon: HeartHandshake,
    title: "Connects you to real support",
    body: "Counselling, legal aid, medical help or protection - Aura points you to the right person, and stays with you while you decide.",
  },
  {
    icon: Lock,
    title: "Protects what you share",
    body: "Your conversations are private by default. Only people you've authorised - or an emergency you ask for - ever see anything.",
  },
]

const PRIVACY_POINTS = [
  { icon: KeyRound, title: "You control access", body: "Nothing is shared with a counsellor, guardian or authority without your consent, or a genuine safety emergency." },
  { icon: FolderLock, title: "Encrypted, always", body: "Conversations and case data are encrypted in transit and at rest. Raw video and audio are never stored." },
  { icon: Eye, title: "No hidden observers", body: "You can always see who has access to your information and why - there's nothing happening behind your back." },
]

export default function Landing({
  onTalkToAura,
  onShowPortals,
  onSelectRole,
}: {
  onTalkToAura: () => void
  onShowPortals: () => void
  onSelectRole: (role: Role) => void
}) {
  const heroRef = useRef<HTMLDivElement>(null)
  const { scrollYProgress } = useScroll({ target: heroRef, offset: ["start start", "end start"] })
  const orbScale = useTransform(scrollYProgress, [0, 1], [1, 0.85])
  const orbOpacity = useTransform(scrollYProgress, [0, 1], [1, 0.4])

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  return (
    <div className="aura-cinematic min-h-screen w-full overflow-x-hidden">
      {/* --- Nav --- */}
      <header className="relative z-20 max-w-[1280px] mx-auto flex items-center justify-between px-6 md:px-10 py-6">
        <span className="text-[20px] font-bold tracking-tight text-[var(--color-ink)]">AURA</span>
        <nav className="hidden md:flex items-center gap-8 text-[14px] text-[var(--color-ink-dim)]">
          <button onClick={() => scrollTo("roles")} className="hover:text-[var(--color-ink)] transition-colors">
            For every role
          </button>
          <button onClick={() => scrollTo("how-it-helps")} className="hover:text-[var(--color-ink)] transition-colors">
            How Aura Helps
          </button>
          <button onClick={() => scrollTo("privacy")} className="hover:text-[var(--color-ink)] transition-colors">
            Privacy
          </button>
        </nav>
        <button
          onClick={onShowPortals}
          className="text-[13px] font-medium text-[var(--color-ink-dim)] hover:text-[var(--color-ink)] transition-colors aura-glass rounded-full px-4 py-2"
        >
          I already have an account
        </button>
      </header>

      {/* --- Hero --- */}
      <section ref={heroRef} className="relative px-6 md:px-10 pt-10 md:pt-16 pb-24">
        <GlowField />

        <div className="relative z-10 max-w-[900px] mx-auto text-center flex flex-col items-center">
          <motion.div initial="hidden" animate="show" variants={fadeInUp}>
            <Pill dot icon={<ShieldCheck size={14} />}>
              Private · Confidential · Always here
            </Pill>
          </motion.div>

          <motion.h1
            initial="hidden"
            animate="show"
            variants={fadeInUp}
            transition={{ delay: 0.08 }}
            className="mt-7 text-[44px] leading-[48px] md:text-[96px] md:leading-[96px] tracking-[-0.03em] font-semibold text-[var(--color-ink)]"
          >
            A safer way<br />
            to be <span className="aura-gradient-text">heard.</span>
          </motion.h1>

          <motion.p
            initial="hidden"
            animate="show"
            variants={fadeInUp}
            transition={{ delay: 0.16 }}
            className="mt-6 max-w-[560px] text-[17px] md:text-[19px] leading-relaxed text-[var(--color-ink-dim)]"
          >
            Aura is a private companion for survivors of abuse - talk in your own words, understand
            how you're really doing, and reach real support. All in one place built to protect you.
          </motion.p>

          <motion.div
            initial="hidden"
            animate="show"
            variants={fadeInUp}
            transition={{ delay: 0.24 }}
            className="mt-9 flex flex-wrap items-center justify-center gap-4"
          >
            <AuraButton onClick={onTalkToAura} icon={<Mic size={18} />}>
              Talk to Aura
            </AuraButton>
            <AuraButton variant="secondary" onClick={() => scrollTo("how-it-helps")} icon={<ArrowRight size={16} />}>
              How Aura Helps
            </AuraButton>
          </motion.div>

          {/* --- Aura visual + floating cards --- */}
          <motion.div
            style={{ scale: orbScale, opacity: orbOpacity }}
            className="relative mt-20 w-full max-w-[640px] aspect-square flex items-center justify-center"
          >
            <div className="absolute inset-[8%] rounded-full border border-white/10" />
            <div className="absolute inset-[18%] rounded-full border border-white/10" />
            <div className="relative w-40 h-40 md:w-52 md:h-52">
              <div className="absolute inset-0 rounded-full aura-glow-violet blur-2xl animate-aura-breathe" />
              <div className="absolute inset-3 rounded-full bg-gradient-to-br from-[var(--color-glow-violet)] via-[#7c5cff] to-[#4b2fc9] shadow-[0_0_80px_rgba(166,130,255,0.55)] animate-aura-breathe" />
              <div className="absolute inset-[38%] rounded-full bg-white/95" />
            </div>

            <FloatCard
              icon={<LineChart size={16} />}
              label="Wellbeing"
              value="Trending steady"
              className="absolute top-[6%] left-[2%] md:left-[-6%] w-[168px]"
              delay={0.1}
            />
            <FloatCard
              icon={<HeartHandshake size={16} />}
              label="Support"
              value="8 pathways"
              className="absolute top-[2%] right-[2%] md:right-[-8%] w-[160px]"
              delay={0.4}
            />
            <FloatCard
              icon={<Sparkles size={16} />}
              label="Case progress"
              value="Investigation stage"
              className="absolute bottom-[16%] left-[-4%] md:left-[-14%] w-[188px]"
              delay={0.7}
            />
            <FloatCard
              icon={<Users size={16} />}
              label="Counsellor"
              value="Available now"
              className="absolute bottom-[10%] right-[-2%] md:right-[-12%] w-[172px]"
              delay={1.0}
            />
            <FloatCard
              icon={<MessagesSquare size={16} />}
              label="AI conversation"
              value="Listening, live"
              className="absolute bottom-[-4%] left-[24%] w-[176px] hidden md:flex"
              delay={1.3}
            />
            <FloatCard
              icon={<Lock size={16} />}
              label="Privacy"
              value="Fully encrypted"
              className="absolute top-[28%] right-[-2%] md:right-[-18%] w-[168px] hidden md:flex"
              delay={1.6}
            />
          </motion.div>
        </div>
      </section>

      {/* --- Built for every role --- */}
      <section id="roles" className="relative px-6 md:px-10 py-24 border-t border-[var(--color-hairline)]">
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={revealOnScroll}
          variants={staggerContainer(0.1)}
          className="max-w-[1100px] mx-auto"
        >
          <motion.p variants={fadeInUp} className="text-[13px] font-semibold uppercase tracking-wide text-[var(--color-glow-amber)] text-center mb-3">
            One system, every role
          </motion.p>
          <motion.h2 variants={fadeInUp} className="text-[30px] md:text-[44px] leading-tight tracking-tight text-center font-semibold text-[var(--color-ink)] max-w-[640px] mx-auto">
            Built for everyone around the case.
          </motion.h2>
          <motion.p variants={fadeInUp} className="mt-4 text-[15px] text-[var(--color-ink-dim)] text-center max-w-[560px] mx-auto">
            Survivor, counsellor, officer and guardian each get their own view - all connected to the same case,
            the same calendar, the same truth.
          </motion.p>

          <div className="mt-14 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {ROLES.map((r) => (
              <motion.button
                key={r.role}
                variants={fadeInUp}
                onClick={() => onSelectRole(r.role)}
                className="text-left aura-glass rounded-3xl p-6 flex flex-col gap-4 hover:bg-white/[0.08] transition-colors group"
              >
                <div
                  className="w-11 h-11 rounded-2xl bg-white/10 flex items-center justify-center"
                  style={{ color: r.glow }}
                >
                  <r.icon size={20} />
                </div>
                <div>
                  <h3 className="text-[17px] font-semibold text-[var(--color-ink)]">{r.title}</h3>
                  <p className="text-[14px] leading-relaxed text-[var(--color-ink-dim)] mt-1.5">{r.body}</p>
                </div>
                <span className="mt-auto inline-flex items-center gap-1.5 text-[13px] font-semibold text-[var(--color-ink)] group-hover:gap-2.5 transition-all">
                  {r.cta} <ArrowRight size={14} />
                </span>
              </motion.button>
            ))}
          </div>
        </motion.div>
      </section>

      {/* --- Connected ecosystem --- */}
      <section className="relative px-6 md:px-10 py-24 border-t border-[var(--color-hairline)]">
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={revealOnScroll}
          variants={staggerContainer(0.1)}
          className="max-w-[1100px] mx-auto"
        >
          <motion.p variants={fadeInUp} className="text-[13px] font-semibold uppercase tracking-wide text-[var(--color-glow-violet)] text-center mb-3">
            Not four dashboards - one ecosystem
          </motion.p>
          <motion.h2 variants={fadeInUp} className="text-[30px] md:text-[44px] leading-tight tracking-tight text-center font-semibold text-[var(--color-ink)] max-w-[680px] mx-auto">
            Case, wellbeing, support and communication - never siloed.
          </motion.h2>

          <div className="mt-16 grid grid-cols-1 md:grid-cols-3 gap-6">
            {CONNECTED.map((c) => (
              <motion.div key={c.title} variants={fadeInUp} className="rounded-3xl p-7 flex flex-col gap-4 border border-[var(--color-hairline)]">
                <div className="w-11 h-11 rounded-full bg-white/5 flex items-center justify-center text-[var(--color-glow-violet)]">
                  <c.icon size={20} />
                </div>
                <h3 className="text-[16px] font-semibold text-[var(--color-ink)]">{c.title}</h3>
                <p className="text-[14px] leading-relaxed text-[var(--color-ink-dim)]">{c.body}</p>
              </motion.div>
            ))}
          </div>
        </motion.div>
      </section>

      {/* --- How Aura Helps --- */}
      <section id="how-it-helps" className="relative px-6 md:px-10 py-24 border-t border-[var(--color-hairline)]">
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={revealOnScroll}
          variants={staggerContainer(0.1)}
          className="max-w-[1100px] mx-auto"
        >
          <motion.p variants={fadeInUp} className="text-[13px] font-semibold uppercase tracking-wide text-[var(--color-glow-violet)] text-center mb-3">
            How Aura Helps
          </motion.p>
          <motion.h2 variants={fadeInUp} className="text-[30px] md:text-[44px] leading-tight tracking-tight text-center font-semibold text-[var(--color-ink)] max-w-[640px] mx-auto">
            A human-first support system, powered by AI.
          </motion.h2>

          <div className="mt-16 grid grid-cols-1 md:grid-cols-2 gap-6">
            {HELPS.map((h) => (
              <motion.div key={h.title} variants={fadeInUp} className="aura-glass rounded-3xl p-7 flex flex-col gap-4">
                <div className="w-12 h-12 rounded-2xl bg-white/10 flex items-center justify-center text-[var(--color-glow-violet)]">
                  <h.icon size={22} />
                </div>
                <h3 className="text-[19px] font-semibold text-[var(--color-ink)]">{h.title}</h3>
                <p className="text-[15px] leading-relaxed text-[var(--color-ink-dim)]">{h.body}</p>
              </motion.div>
            ))}
          </div>
        </motion.div>
      </section>

      {/* --- Privacy --- */}
      <section id="privacy" className="relative px-6 md:px-10 py-24 border-t border-[var(--color-hairline)]">
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={revealOnScroll}
          variants={staggerContainer(0.1)}
          className="max-w-[1100px] mx-auto"
        >
          <motion.p variants={fadeInUp} className="text-[13px] font-semibold uppercase tracking-wide text-[var(--color-glow-teal)] text-center mb-3">
            Privacy, by design
          </motion.p>
          <motion.h2 variants={fadeInUp} className="text-[30px] md:text-[44px] leading-tight tracking-tight text-center font-semibold text-[var(--color-ink)] max-w-[600px] mx-auto">
            Who sees your information - and why.
          </motion.h2>

          <div className="mt-16 grid grid-cols-1 md:grid-cols-3 gap-6">
            {PRIVACY_POINTS.map((p) => (
              <motion.div key={p.title} variants={fadeInUp} className="rounded-3xl p-7 flex flex-col gap-4 border border-[var(--color-hairline)]">
                <div className="w-11 h-11 rounded-full bg-white/5 flex items-center justify-center text-[var(--color-glow-teal)]">
                  <p.icon size={20} />
                </div>
                <h3 className="text-[16px] font-semibold text-[var(--color-ink)]">{p.title}</h3>
                <p className="text-[14px] leading-relaxed text-[var(--color-ink-dim)]">{p.body}</p>
              </motion.div>
            ))}
          </div>
        </motion.div>
      </section>

      {/* --- Final CTA --- */}
      <section className="relative px-6 md:px-10 py-24 border-t border-[var(--color-hairline)] text-center">
        <motion.div initial="hidden" whileInView="show" viewport={revealOnScroll} variants={fadeInUp}>
          <h2 className="text-[28px] md:text-[40px] font-semibold tracking-tight text-[var(--color-ink)]">
            Whenever you're ready, Aura is here.
          </h2>
          <p className="mt-4 text-[15px] text-[var(--color-ink-dim)] max-w-[480px] mx-auto">
            No forms to start. No pressure to share more than you want to.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
            <AuraButton onClick={onTalkToAura} icon={<Mic size={18} />}>
              Talk to Aura
            </AuraButton>
          </div>
        </motion.div>
      </section>

      <footer className="px-6 md:px-10 py-10 border-t border-[var(--color-hairline)] flex flex-col md:flex-row items-center justify-between gap-4 max-w-[1280px] mx-auto">
        <span className="text-[15px] font-bold text-[var(--color-ink)]">AURA</span>
        <p className="text-[13px] text-[var(--color-ink-faint)] text-center">
          Aura offers supportive guidance and does not replace professional care or emergency services.
        </p>
        <button onClick={onShowPortals} className="text-[13px] text-[var(--color-ink-dim)] hover:text-[var(--color-ink)] transition-colors">
          Counsellor / Admin / Guardian portals
        </button>
      </footer>
    </div>
  )
}
