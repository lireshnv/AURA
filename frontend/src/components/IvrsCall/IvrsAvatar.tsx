import { Phone, Mic, Loader2, Volume2, Circle } from "lucide-react"

export type IvrsAvatarState = "ringing" | "listening" | "thinking" | "speaking" | "idle" | "ended"

const STATE_META: Record<
  IvrsAvatarState,
  { label: string; ring: string; icon: JSX.Element; pulse: boolean }
> = {
  ringing: {
    label: "Ringing…",
    ring: "border-tertiary bg-tertiary/10",
    icon: <Phone size={30} className="text-tertiary animate-bounce" />,
    pulse: true,
  },
  listening: {
    label: "Listening",
    ring: "border-secondary bg-secondary/10",
    icon: <Mic size={30} className="text-secondary" />,
    pulse: true,
  },
  thinking: {
    label: "Thinking…",
    ring: "border-primary bg-primary/10",
    icon: <Loader2 size={30} className="text-primary animate-spin" />,
    pulse: false,
  },
  speaking: {
    label: "Speaking",
    ring: "border-primary bg-primary/15",
    icon: <Volume2 size={30} className="text-primary animate-pulse" />,
    pulse: true,
  },
  idle: {
    label: "Idle",
    ring: "border-outline-variant bg-surface-container-low",
    icon: <Circle size={26} className="text-on-surface-variant" />,
    pulse: false,
  },
  ended: {
    label: "Call ended",
    ring: "border-outline-variant bg-surface-container-low",
    icon: <Phone size={28} className="text-on-surface-variant" />,
    pulse: false,
  },
}

export default function IvrsAvatar({ state }: { state: IvrsAvatarState }) {
  const meta = STATE_META[state]
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative w-32 h-32 flex items-center justify-center">
        {meta.pulse && (
          <span className={`absolute inset-0 rounded-full border-2 ${meta.ring} animate-ping opacity-40`} />
        )}
        <div
          className={`relative w-28 h-28 rounded-full border-2 flex items-center justify-center ${meta.ring} transition-colors duration-300`}
        >
          <span className="text-3xl font-bold text-primary">A</span>
          <div className="absolute -bottom-1 -right-1 w-9 h-9 rounded-full bg-surface-container-lowest border border-outline-variant flex items-center justify-center shadow-sm">
            {meta.icon}
          </div>
        </div>
      </div>
      <span className="text-label-sm font-medium text-on-surface-variant flex items-center gap-1.5">
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            state === "speaking" || state === "listening" || state === "ringing"
              ? "bg-secondary animate-pulse"
              : "bg-outline-variant"
          }`}
        />
        {meta.label}
      </span>
    </div>
  )
}
