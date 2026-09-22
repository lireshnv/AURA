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
  ringing: "text-violet-700 bg-violet-50 border-violet-200",
  answered: "text-emerald-700 bg-emerald-50 border-emerald-200",
  declined: "text-amber-700 bg-amber-50 border-amber-200",
  completed: "text-slate-600 bg-slate-100 border-slate-200",
  failed: "text-rose-700 bg-rose-50 border-rose-200",
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
    return <p className="text-sm text-slate-500">Loading AURA Call…</p>
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
          <PhoneCall size={20} className="text-violet-600" />
          AURA Call
        </h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Place a real, voiced wellness call to an authorised victim.
        </p>
      </div>

      <section className="rounded-xl bg-white border border-slate-200 p-5 space-y-4">
        {victims.length === 0 ? (
          <p className="text-sm text-slate-500">
            No authorised victims yet. An administrator assigns victims to your account.
          </p>
        ) : (
          <>
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                Victim
              </label>
              <select
                value={selectedVictim}
                onChange={(e) => setSelectedVictim(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm bg-white"
              >
                {victims.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                Reason
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {reasons.map((r) => (
                  <button
                    key={r.key}
                    onClick={() => setSelectedReason(r.key)}
                    className={`flex flex-col items-center gap-1 rounded-xl border p-3 text-center transition-colors ${
                      selectedReason === r.key ? "border-violet-500 bg-violet-50" : "border-slate-200 hover:bg-slate-50"
                    }`}
                  >
                    <span className="text-lg">{r.emoji}</span>
                    <span className="text-[11px] font-medium text-slate-700">{r.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {isCustom && (
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                  Custom message
                </label>
                <textarea
                  value={customMessage}
                  onChange={(e) => setCustomMessage(e.target.value)}
                  rows={3}
                  placeholder="Exactly what AURA should say to open the call…"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm resize-none"
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                Message preview
              </label>
              <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2.5 text-sm text-slate-700 italic">
                “{previewMessage}”
              </div>
            </div>

            {result && (
              <div
                className={`flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${
                  result.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-800"
                }`}
              >
                {result.ok ? <CheckCircle2 size={14} className="mt-0.5 shrink-0" /> : <XCircle size={14} className="mt-0.5 shrink-0" />}
                {result.message}
              </div>
            )}

            <button
              onClick={generate}
              disabled={generating || !selectedVictim || (isCustom && !customMessage.trim())}
              className="w-full py-2.5 rounded-full bg-violet-600 hover:bg-violet-500 text-white text-sm font-semibold disabled:opacity-40 flex items-center justify-center gap-2"
            >
              {generating && <Loader2 size={15} className="animate-spin" />}
              Generate Call
            </button>
          </>
        )}
      </section>

      <section className="rounded-xl bg-white border border-slate-200 p-5">
        <h2 className="text-sm font-semibold text-slate-900 mb-3">Calls you've placed</h2>
        {history.length === 0 ? (
          <p className="text-sm text-slate-500">No calls</p>
        ) : (
          <div className="space-y-2">
            {history.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-3 py-2 border-b border-slate-100 last:border-0">
                <div className="min-w-0">
                  <p className="text-sm text-slate-800 truncate">
                    {c.aura_id} <span className="text-slate-400">· {c.reason_key.replace(/_/g, " ")}</span>
                  </p>
                  <p className="text-[11px] text-slate-400">{new Date(c.started_at).toLocaleString()}</p>
                </div>
                <span
                  className={`shrink-0 px-2 py-0.5 rounded-full border text-[10px] font-semibold uppercase ${
                    STATUS_STYLE[c.status] ?? "text-slate-500 bg-slate-50 border-slate-200"
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
