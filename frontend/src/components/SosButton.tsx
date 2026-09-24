import { useEffect, useRef, useState } from "react"
import { AlertTriangle, X, Loader2, CheckCircle2, XCircle } from "lucide-react"
import { getBestEffortLocation, triggerSos } from "../lib/sosApi"

// Same generic, non-fabricated crisis guidance already used server-side in
// chat_safety.py's DEFAULT_RESOURCES - no invented hotline numbers.
const SOS_RESOURCES = [
  { label: "112 — Emergency services", detail: "If you are in immediate danger, contact 112 (police/fire/medical, nationwide)." },
  { label: "14416 — Tele-MANAS", detail: "India's national 24/7 mental health support and counselling helpline. Also 1-800-891-4416." },
  { label: "A person you trust", detail: "Someone who can physically be with you right now." },
  { label: "Your AURA counsellor", detail: "You can request human support from Well-being & Risk at any time." },
]

type Phase = "idle" | "confirm" | "sending" | "sent" | "failed"

/**
 * Dedicated SOS affordance, separate from normal navigation. Pressing it
 * asks for confirmation, then optionally asks the browser for location
 * (best-effort - a decline never blocks sending), then records ONE real SOS
 * event server-side. Nothing here is a fake contact, location, or demo event
 * - "Sent" only ever means the event was actually written to the store.
 */
export default function SosButton({ page, externalTrigger }: { page: string; externalTrigger?: number }) {
  const [phase, setPhase] = useState<Phase>("idle")
  const [locationIncluded, setLocationIncluded] = useState(false)
  const [sentAt, setSentAt] = useState<string | null>(null)
  const lastTriggerRef = useRef(externalTrigger)

  // Lets a caller elsewhere in the tree (e.g. Victim Home's "I'm not feeling
  // safe" tile) open the SAME real confirm flow as the floating button,
  // rather than duplicating SOS logic in a second place.
  useEffect(() => {
    if (externalTrigger === undefined || externalTrigger === lastTriggerRef.current) return
    lastTriggerRef.current = externalTrigger
    setPhase("confirm")
  }, [externalTrigger])

  const reset = () => {
    setPhase("idle")
    setLocationIncluded(false)
    setSentAt(null)
  }

  const send = async () => {
    setPhase("sending")
    const location = await getBestEffortLocation()
    const result = await triggerSos({
      latitude: location?.latitude,
      longitude: location?.longitude,
      page,
    })
    if (result.success) {
      setLocationIncluded(!!result.has_location)
      setSentAt(result.timestamp ?? new Date().toISOString())
      setPhase("sent")
    } else {
      setPhase("failed")
    }
  }

  return (
    <div className="fixed bottom-6 right-4 sm:bottom-8 sm:right-8 z-50 flex flex-col items-end gap-3 max-w-[calc(100vw-2rem)]">
      {phase !== "idle" && (
        <div className="w-80 max-w-full bg-surface-container-lowest rounded-2xl shadow-xl border border-outline-variant p-4">
          {phase === "confirm" && (
            <>
              <div className="flex items-start justify-between gap-2 mb-2">
                <p className="text-label-md font-bold text-on-surface">Send an SOS alert?</p>
                <button onClick={reset} aria-label="Cancel" className="text-on-surface-variant hover:text-on-surface shrink-0">
                  <X size={16} />
                </button>
              </div>
              <p className="text-label-sm text-on-surface-variant mb-3">
                This records a real SOS event with your AURA-ID and, if you allow it, your current
                location. It does not call emergency services automatically.
              </p>
              <div className="flex gap-2 mb-3">
                <button
                  onClick={send}
                  className="flex-1 px-3 py-2 rounded-full bg-error text-on-error text-label-sm font-bold"
                >
                  Send SOS Now
                </button>
                <button
                  onClick={reset}
                  className="px-3 py-2 rounded-full border border-outline-variant text-on-surface-variant text-label-sm"
                >
                  Cancel
                </button>
              </div>
              <div className="pt-3 border-t border-outline-variant">
                <p className="text-label-sm font-bold text-on-surface mb-1.5">Support is available right now</p>
                <ul className="space-y-1.5">
                  {SOS_RESOURCES.map((r) => (
                    <li key={r.label} className="text-label-sm text-on-surface-variant">
                      <span className="font-bold text-on-surface">{r.label}</span> — {r.detail}
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}

          {phase === "sending" && (
            <div className="flex items-center gap-2 py-2">
              <Loader2 size={18} className="text-error animate-spin" />
              <p className="text-label-md text-on-surface">Sending SOS alert…</p>
            </div>
          )}

          {phase === "sent" && (
            <>
              <div className="flex items-center gap-2 mb-1.5">
                <CheckCircle2 size={18} className="text-secondary" />
                <p className="text-label-md font-bold text-on-surface">SOS alert sent</p>
              </div>
              <p className="text-label-sm text-on-surface-variant">
                Recorded {sentAt ? new Date(sentAt).toLocaleTimeString() : "just now"}
                {locationIncluded ? " with your current location." : " without location (not shared)."}
              </p>
              <button
                onClick={reset}
                className="mt-3 w-full px-3 py-2 rounded-full border border-outline-variant text-on-surface-variant text-label-sm"
              >
                Close
              </button>
            </>
          )}

          {phase === "failed" && (
            <>
              <div className="flex items-center gap-2 mb-1.5">
                <XCircle size={18} className="text-error" />
                <p className="text-label-md font-bold text-on-surface">Could not send SOS</p>
              </div>
              <p className="text-label-sm text-on-surface-variant mb-3">
                The alert was not recorded. Check your connection, or contact emergency services
                directly if you are in immediate danger.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={send}
                  className="flex-1 px-3 py-2 rounded-full bg-error text-on-error text-label-sm font-bold"
                >
                  Try Again
                </button>
                <button
                  onClick={reset}
                  className="px-3 py-2 rounded-full border border-outline-variant text-on-surface-variant text-label-sm"
                >
                  Close
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {phase === "idle" && (
        <div className="relative">
          <span className="absolute inset-0 rounded-full bg-error/50 animate-ping" />
          <button
            onClick={() => setPhase("confirm")}
            aria-label="Send SOS alert"
            className="relative bg-error text-on-error rounded-full w-16 h-16 sm:w-[72px] sm:h-[72px] shadow-lg shadow-error/30 hover:scale-105 active:scale-95 transition-transform flex flex-col items-center justify-center gap-0.5 border-2 border-on-error/20"
          >
            <AlertTriangle size={24} className="text-on-error" />
            <span className="text-[11px] font-extrabold uppercase tracking-widest">SOS</span>
          </button>
        </div>
      )}
    </div>
  )
}
