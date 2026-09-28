import { useEffect, useState } from "react"
import { User, Cpu, ShieldCheck, Server, Compass, Clock, CalendarClock } from "lucide-react"
import { VoiceCapabilities } from "../types"
import { API_BASE_URL } from "../lib/api"
import { fetchSupportHistory, InterventionRecord } from "../lib/auraApi"
import CaseDocuments from "./CaseDocuments"
import HistoryPage from "./HistoryPage"

// Same plain-language status mapping used on Support's "Your Case" card -
// kept here too since Your Journey shows the same underlying record from a
// different angle (a timeline of the case, rather than a status list).
const STATUS_COPY: Record<string, { label: string; tone: string }> = {
  approved: { label: "Approved — being arranged for you", tone: "text-secondary" },
  rejected: { label: "Reviewed — this path wasn't taken forward", tone: "text-on-surface-variant" },
  escalated: { label: "Escalated for closer attention", tone: "text-primary" },
}

function Row({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-outline-variant/40 last:border-0">
      <span className="text-xs text-on-surface-variant">{label}</span>
      <span
        className={`text-xs font-medium ${
          ok === undefined ? "text-on-surface-variant" : ok ? "text-on-secondary-container" : "text-amber-700"
        }`}
      >
        {value}
      </span>
    </div>
  )
}

export default function ProfilePage({
  auraId = "",
  capabilities,
  backendOnline,
}: {
  auraId?: string
  capabilities: VoiceCapabilities | null
  backendOnline: boolean | null
}) {
  const [version, setVersion] = useState<string>("—")
  const [caseHistory, setCaseHistory] = useState<InterventionRecord[] | null>(null)

  useEffect(() => {
    fetch(`${API_BASE_URL}/api/version`)
      .then((r) => r.json())
      .then((d) => setVersion(d.version ?? "—"))
      .catch(() => setVersion("unavailable"))
  }, [])

  useEffect(() => {
    if (!auraId) return
    fetchSupportHistory(auraId).then((r) => setCaseHistory(r?.interventions ?? []))
  }, [auraId])

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-headline-md text-on-surface">Profile &amp; System</h1>
        <p className="text-body-md text-on-surface-variant mt-0.5">
          Your account, your journey so far, and what this installation can currently do.
        </p>
      </div>

      <section className="rounded-xl bg-surface-container-lowest border border-outline-variant p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-on-surface mb-2">
          <User size={14} className="text-primary" />
          Account
        </h2>
        <Row label="AURA ID" value={auraId || "—"} />
        <Row label="Stored data" value="Structured signals only" />
        <p className="text-[11px] text-on-surface-variant mt-3">
          Analysis history is stored against this account and can be cleared at any time from
          Your Journey below.
        </p>
      </section>

      {/* Your Journey - everything tracked against this case in one place:
          where things stand (past decisions, no fabricated "upcoming" items
          since there's no scheduling system behind this yet - an honest
          empty state instead), and documents kept with the case. Only
          meaningful when this profile belongs to a victim's case - a
          counsellor viewing their own device profile has no case to show. */}
      {auraId && (
        <section className="rounded-xl bg-surface-container-lowest border border-outline-variant p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-on-surface mb-3">
            <Compass size={14} className="text-primary" />
            Your Journey
          </h2>

          <div className="space-y-4">
            <div>
              <h3 className="flex items-center gap-1.5 text-xs font-semibold text-on-surface-variant uppercase tracking-wide mb-2">
                <Clock size={12} /> Past
              </h3>
              {caseHistory === null ? (
                <p className="text-xs text-on-surface-variant">Loading…</p>
              ) : caseHistory.length === 0 ? (
                <p className="text-xs text-on-surface-variant">Nothing recorded against your case yet.</p>
              ) : (
                <div className="space-y-1.5">
                  {caseHistory.map((h) => {
                    const status = STATUS_COPY[h.status] ?? { label: h.status, tone: "text-on-surface-variant" }
                    const when = h.decided_at ?? h.created_at
                    return (
                      <div key={h.id} className="flex items-center justify-between text-xs border-b border-outline-variant/40 pb-1.5 last:border-0">
                        <span className="text-on-surface font-medium capitalize">{h.pathway.replace(/_/g, " ")}</span>
                        <span className={status.tone}>{status.label}</span>
                        <span className="text-on-surface-variant/70">{new Date(when).toLocaleDateString()}</span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            <div>
              <h3 className="flex items-center gap-1.5 text-xs font-semibold text-on-surface-variant uppercase tracking-wide mb-2">
                <CalendarClock size={12} /> Upcoming
              </h3>
              <p className="text-xs text-on-surface-variant">
                Nothing scheduled right now — your counsellor will let you know here if a follow-up is arranged.
              </p>
            </div>

            <div>
              <h3 className="text-xs font-semibold text-on-surface-variant uppercase tracking-wide mb-2">
                Case documents
              </h3>
              <CaseDocuments auraId={auraId} />
            </div>
          </div>
        </section>
      )}

      <section className="rounded-xl bg-surface-container-lowest border border-outline-variant p-5">
        <h2 className="text-sm font-semibold text-on-surface mb-3">Session history</h2>
        <HistoryPage compact />
      </section>

      <section className="rounded-xl bg-surface-container-lowest border border-outline-variant p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-on-surface mb-2">
          <Cpu size={14} className="text-primary" />
          Analysis capabilities
        </h2>
        {capabilities ? (
          <>
            <Row
              label={`Face analysis (MediaPipe + ${capabilities.face_emotion_backend === "deepface" ? "DeepFace" : "FER+ ONNX"})`}
              value={capabilities.face_emotion ? "Available" : "Unavailable"}
              ok={!!capabilities.face_emotion}
            />
            <Row
              label="Audio decoding"
              value={capabilities.audio_decode ? "Available" : "Unavailable"}
              ok={capabilities.audio_decode}
            />
            <Row
              label="Acoustic features (librosa)"
              value={capabilities.acoustic_features ? "Available" : "Unavailable"}
              ok={capabilities.acoustic_features}
            />
            <Row label="Voice activity detection" value={capabilities.vad} ok />
            <Row
              label={`Speech-to-text (ElevenLabs ${capabilities.stt_model})`}
              value={capabilities.speech_to_text ? "Available" : "Unavailable"}
              ok={capabilities.speech_to_text}
            />
            <Row
              label="Voice tone model"
              value={capabilities.voice_emotion ? "Available" : "Unavailable"}
              ok={capabilities.voice_emotion}
            />
            <Row
              label="Text emotion model"
              value={capabilities.text_emotion ? "Available" : "Unavailable"}
              ok={capabilities.text_emotion}
            />
          </>
        ) : (
          <p className="text-xs text-on-surface-variant">Capabilities unavailable — service offline.</p>
        )}
      </section>

      <section className="rounded-xl bg-surface-container-lowest border border-outline-variant p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-on-surface mb-2">
          <Server size={14} className="text-primary" />
          Service
        </h2>
        <Row
          label="Backend"
          value={backendOnline ? "Connected" : "Offline"}
          ok={backendOnline ?? false}
        />
        <Row label="Endpoint" value={API_BASE_URL} />
        <Row label="API version" value={version} />
        <Row label="Explanation engine" value="Deterministic (local)" />
      </section>

      <section className="rounded-xl bg-surface-container-high border border-outline-variant p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-on-surface mb-1.5">
          <ShieldCheck size={14} className="text-on-surface-variant" />
          Privacy
        </h2>
        <ul className="text-xs text-on-surface-variant space-y-1 leading-relaxed">
          <li>· Camera and microphone are active only during an analysis session.</li>
          <li>· Raw video, raw audio and face images are never written to disk.</li>
          <li>· Only scores, timestamps and a short transcript excerpt are stored.</li>
          <li>· Analysis runs locally; no session data is sent to a third-party service.</li>
          <li>· History can be cleared permanently at any time.</li>
        </ul>
      </section>
    </div>
  )
}
