import { HeartHandshake, Stethoscope, ShieldCheck, Users } from "lucide-react"
import { Role } from "../../lib/authApi"

const PORTALS: {
  role: Role
  label: string
  description: string
  icon: typeof HeartHandshake
  accent: string
}[] = [
  {
    role: "victim",
    label: "I need support",
    description: "Emotion analysis, well-being tracking and your AI companion.",
    icon: HeartHandshake,
    accent: "from-primary/15 to-primary/5 text-primary border-primary/20",
  },
  {
    role: "counsellor",
    label: "Counsellor",
    description: "Review authorised cases, trends and session history.",
    icon: Stethoscope,
    accent: "from-secondary/15 to-secondary/5 text-secondary border-secondary/20",
  },
  {
    role: "admin",
    label: "Administrator",
    description: "Manage accounts, access and system status.",
    icon: ShieldCheck,
    accent: "from-tertiary/15 to-tertiary/5 text-tertiary border-tertiary/20",
  },
  {
    role: "guardian",
    label: "Guardian",
    description: "See a linked victim's authorised well-being summary.",
    icon: Users,
    accent: "from-error/15 to-error/5 text-error border-error/20",
  },
]

export default function PortalSelector({
  onSelect,
  googleError,
}: {
  onSelect: (role: Role) => void
  googleError?: boolean
}) {
  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-6 py-12">
      <div className="text-center mb-10">
        <span className="text-display-lg text-primary font-bold tracking-tighter">AURA</span>
        <p className="text-body-lg text-on-surface-variant mt-2 max-w-md mx-auto">
          Choose how you're using AURA today.
        </p>
        {googleError && (
          <p className="text-label-md text-error mt-3">
            Google sign-in didn't complete. Please choose your portal and try again.
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 w-full max-w-2xl">
        {PORTALS.map((p) => (
          <button
            key={p.role}
            onClick={() => onSelect(p.role)}
            className={`bg-gradient-to-br ${p.accent} border rounded-[24px] p-6 flex flex-col items-center text-center gap-3 hover:scale-[1.02] transition-transform card-shadow`}
          >
            <div className="w-16 h-16 rounded-full bg-surface-container-lowest flex items-center justify-center shadow-sm">
              <p.icon size={28} />
            </div>
            <h2 className="text-headline-md text-on-surface font-bold">{p.label}</h2>
            <p className="text-label-md text-on-surface-variant">{p.description}</p>
          </button>
        ))}
      </div>

      <p className="text-label-sm text-on-surface-variant mt-10 max-w-md text-center">
        AURA analyses observable signals to support human decisions - it is not a diagnostic tool.
      </p>
    </div>
  )
}
