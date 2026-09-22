import { useCallback, useEffect, useState } from "react"
import { PhoneCall, Loader2, CheckCircle2, XCircle } from "lucide-react"
import { fetchMyVictims } from "../lib/authApi"
import {
  CallReasonOption,
  IvrsCallSummary,
  fetchCallReasons,
  fetchGeneratedCalls,
  generateCall,
} from "../lib/ivrsApi"

const STATUS_STYLE: Record<string, string> = {
  ringing: "text-primary bg-primary-container/10 border-primary/20",
  answered: "text-on-secondary-container bg-secondary-container/20 border-secondary/20",
  declined: "text-amber-700 bg-amber-50 border-amber-200",
  completed: "text-on-surface-variant bg-surface-container-high border-outline-variant",
  failed: "text-error bg-error-container/20 border-error/40",
}

/**
 * The counsellor's "AURA Call" section: pick an authorised victim and a
 * predefined reason, preview the exact message, and generate a REAL call
 * session - the victim's dashboard receives it over the same real-time
 * channel the moment this succeeds. No fake call data: nothing here is
 * shown as sent unless the backend actually created the session.
 */
export default function CounsellorCallPanel() {
  const [victims, setVictims] = useState<string[]>([])
  const [reasons, setReasons] = useState<CallReasonOption[]>([])
  const [selectedVictim, setSelectedVictim] = useState("")
  const [selectedReason, setSelectedReason] = useState("")
  const [customMessage, setCustomMessage] = useState("")
  const [generating, setGenerating] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [history, setHistory] = useState<IvrsCallSummary[]>([])
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    const [v, r, h] = await Promise.all([fetchMyVictims(), fetchCallReasons(), fetchGeneratedCalls()])
    setVictims(v)
    setReasons(r)
    if (v.length > 0) setSelectedVictim((s) => s || v[0])
    if (r.length > 0) setSelectedReason((s) => s || r[0].key)
    setHistory(h)
    setLoading(false)
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const reason = reasons.find((r) => r.key === selectedReason)
  const isCustom = selectedReason === "custom"
  const previewMessage = isCustom ? customMessage || "Type your message below…" : reason?.message ?? ""

  const generate = async () => {
    if (!selectedVictim || !selectedReason) return
    if (isCustom && !customMessage.trim()) {
      setResult({ ok: false, message: "Enter a custom message before generating the call." })
      return
    }
    setGenerating(true)
    setResult(null)
    const res = await generateCall(selectedVictim, selectedReason, isCustom ? customMessage.trim() : undefined)
    setGenerating(false)
    if (res?.success) {
      setResult({ ok: true, message: `Call placed to ${selectedVictim}.` })
      setCustomMessage("")
      reload()
    } else {
      setResult({ ok: false, message: res?.error ?? "Could not generate the call." })
    }
  }

  if (loading) {
    return <p className="text-sm text-on-surface-variant">Loading AURA Call…</p>
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-headline-md text-on-surface flex items-center gap-2">
          <PhoneCall size={20} className="text-primary" />
          AURA Call
        </h1>
        <p className="text-body-md text-on-surface-variant mt-0.5">
          Place a real, voiced wellness call to an authorised victim.
        </p>
      </div>

      <section className="rounded-xl bg-surface-container-lowest border border-outline-variant p-5 space-y-4">
        {victims.length === 0 ? (
          <p className="text-sm text-on-surface-variant">
            No authorised victims yet. An administrator assigns victims to your account.
          </p>
        ) : (
          <>
            <div>
              <label className="block text-xs font-semibold text-on-surface-variant uppercase tracking-wide mb-1.5">
                Victim
              </label>
              <select
                value={selectedVictim}
                onChange={(e) => setSelectedVictim(e.target.value)}
                className="w-full rounded-lg border border-outline-variant px-3 py-2.5 text-sm bg-surface-container-lowest"
              >
                {victims.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-on-surface-variant uppercase tracking-wide mb-1.5">
                Reason
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {reasons.map((r) => (
                  <button
                    key={r.key}
                    onClick={() => setSelectedReason(r.key)}
                    className={`flex flex-col items-center gap-1 rounded-xl border p-3 text-center transition-colors ${
                      selectedReason === r.key ? "border-primary bg-primary-container/10" : "border-outline-variant hover:bg-surface-container-low"
                    }`}
                  >
                    <span className="text-lg">{r.emoji}</span>
                    <span className="text-[11px] font-medium text-on-surface-variant">{r.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {isCustom && (
              <div>
                <label className="block text-xs font-semibold text-on-surface-variant uppercase tracking-wide mb-1.5">
                  Custom message
                </label>
                <textarea
                  value={customMessage}
                  onChange={(e) => setCustomMessage(e.target.value)}
                  rows={3}
                  placeholder="Exactly what AURA should say to open the call…"
                  className="w-full rounded-lg border border-outline-variant px-3 py-2 text-sm resize-none"
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-on-surface-variant uppercase tracking-wide mb-1.5">
                Message preview
              </label>
              <div className="rounded-lg bg-surface-container-low border border-outline-variant px-3 py-2.5 text-sm text-on-surface-variant italic">
                “{previewMessage}”
              </div>
            </div>

            {result && (
              <div
                className={`flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${
                  result.ok ? "bg-secondary-container/20 text-on-secondary-container" : "bg-error-container text-on-error-container"
                }`}
              >
                {result.ok ? <CheckCircle2 size={14} className="mt-0.5 shrink-0" /> : <XCircle size={14} className="mt-0.5 shrink-0" />}
                {result.message}
              </div>
            )}

            <button
              onClick={generate}
              disabled={generating || !selectedVictim || (isCustom && !customMessage.trim())}
              className="w-full py-2.5 rounded-full bg-primary hover:bg-primary-fixed-dim text-on-primary text-sm font-semibold disabled:opacity-40 flex items-center justify-center gap-2"
            >
              {generating && <Loader2 size={15} className="animate-spin" />}
              Generate Call
            </button>
          </>
        )}
      </section>

      <section className="rounded-xl bg-surface-container-lowest border border-outline-variant p-5">
        <h2 className="text-sm font-semibold text-on-surface mb-3">Calls you've placed</h2>
        {history.length === 0 ? (
          <p className="text-sm text-on-surface-variant">No calls</p>
        ) : (
          <div className="space-y-2">
            {history.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-3 py-2 border-b border-outline-variant/40 last:border-0">
                <div className="min-w-0">
                  <p className="text-sm text-on-surface truncate">
                    {c.aura_id} <span className="text-on-surface-variant/70">· {c.reason_key.replace(/_/g, " ")}</span>
                  </p>
                  <p className="text-[11px] text-on-surface-variant/70">{new Date(c.started_at).toLocaleString()}</p>
                </div>
                <span
                  className={`shrink-0 px-2 py-0.5 rounded-full border text-[10px] font-semibold uppercase ${
                    STATUS_STYLE[c.status] ?? "text-on-surface-variant bg-surface-container-low border-outline-variant"
                  }`}
                >
                  {c.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
