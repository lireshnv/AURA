import { useEffect, useState } from "react"
import { User, Cpu, ShieldCheck, Server } from "lucide-react"
import { VoiceCapabilities } from "../types"
import { API_BASE_URL } from "../lib/api"

function Row({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-slate-100 last:border-0">
      <span className="text-xs text-slate-500">{label}</span>
      <span
        className={`text-xs font-medium ${
          ok === undefined ? "text-slate-700" : ok ? "text-emerald-700" : "text-amber-700"
        }`}
      >
        {value}
      </span>
    </div>
  )
}

export default function ProfilePage({
  capabilities,
  backendOnline,
}: {
  capabilities: VoiceCapabilities | null
  backendOnline: boolean | null
}) {
  const [version, setVersion] = useState<string>("—")

  useEffect(() => {
    fetch(`${API_BASE_URL}/api/version`)
      .then((r) => r.json())
      .then((d) => setVersion(d.version ?? "—"))
      .catch(() => setVersion("unavailable"))
  }, [])

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-slate-900">Profile &amp; System</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Session settings and what this installation can currently do.
        </p>
      </div>

      <section className="rounded-xl bg-white border border-slate-200 p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900 mb-2">
          <User size={14} className="text-violet-600" />
          Account
        </h2>
        <Row label="Mode" value="Local session (no sign-in)" />
        <Row label="Stored data" value="Structured signals only" />
        <p className="text-[11px] text-slate-500 mt-3">
          This prototype runs without accounts. Analysis history is stored locally on this
          machine and can be cleared at any time from the History page.
        </p>
      </section>

      <section className="rounded-xl bg-white border border-slate-200 p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900 mb-2">
          <Cpu size={14} className="text-violet-600" />
          Analysis capabilities
        </h2>
        {capabilities ? (
          <>
            <Row label="Face analysis (MediaPipe + OpenCV + DeepFace)" value="Available" ok />
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
          <p className="text-xs text-slate-500">Capabilities unavailable — service offline.</p>
        )}
      </section>

      <section className="rounded-xl bg-white border border-slate-200 p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900 mb-2">
          <Server size={14} className="text-violet-600" />
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

      <section className="rounded-xl bg-slate-100 border border-slate-200 p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900 mb-1.5">
          <ShieldCheck size={14} className="text-slate-500" />
          Privacy
        </h2>
        <ul className="text-xs text-slate-600 space-y-1 leading-relaxed">
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
