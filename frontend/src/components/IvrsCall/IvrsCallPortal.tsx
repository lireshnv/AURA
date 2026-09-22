import { useCallback, useEffect, useRef, useState } from "react"
import { Check, X, Mic, Square, Send, PhoneOff, AlertTriangle, Volume2, VolumeX } from "lucide-react"
import {
  CallEvent,
  NotificationEvent,
  attendCall,
  audioReplyUrl,
  connectCallSocket,
  connectNotificationSocket,
  declineCall,
  endCall,
  sendAudioTurn,
  sendTextTurn,
} from "../../lib/ivrsApi"
import IvrsAvatar, { IvrsAvatarState } from "./IvrsAvatar"

type Phase = "idle" | "incoming" | "call" | "summary"

interface TranscriptLine {
  role: "user" | "aura"
  text: string
}

function formatTimer(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, "0")}`
}

/**
 * Global, reactive AURA call overlay for the victim role - mounted once
 * regardless of which page they're on (like the SOS button). It never
 * initiates a call itself; it only listens on the victim's notification
 * WebSocket and reacts to a real counsellor-generated call the moment it
 * arrives, then renders full-screen over whatever else is on screen.
 */
export default function IvrsCallPortal() {
  const [phase, setPhase] = useState<Phase>("idle")
  const [incoming, setIncoming] = useState<NotificationEvent | null>(null)
  const [callId, setCallId] = useState<string | null>(null)
  const [avatarState, setAvatarState] = useState<IvrsAvatarState>("idle")
  const [transcript, setTranscript] = useState<TranscriptLine[]>([])
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [recording, setRecording] = useState(false)
  const [summaryNote, setSummaryNote] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [wsConnected, setWsConnected] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [muted, setMuted] = useState(false)

  const notifyWsRef = useRef<WebSocket | null>(null)
  const callWsRef = useRef<WebSocket | null>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)

  // Standing notification channel - open for the lifetime of the victim's
  // session so a call can arrive on any page, at any time.
  useEffect(() => {
    const ws = connectNotificationSocket((event) => {
      if (event.type === "incoming_call") {
        setIncoming(event)
        setCallId(event.call_id)
        setAvatarState("ringing")
        setPhase("incoming")
      }
    })
    notifyWsRef.current = ws
    return () => {
      ws?.close()
    }
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
  }, [transcript])

  useEffect(() => {
    if (phase !== "call") return
    const id = window.setInterval(() => setElapsed((e) => e + 1), 1000)
    return () => window.clearInterval(id)
  }, [phase])

  const closeCallSocket = useCallback(() => {
    callWsRef.current?.close()
    callWsRef.current = null
    setWsConnected(false)
  }, [])

  const playAuraLine = useCallback(
    (id: string, text: string) => {
      if (muted || !audioRef.current) {
        setAvatarState("idle")
        return
      }
      audioRef.current.src = audioReplyUrl(id, text)
      setAvatarState("speaking")
      audioRef.current.play().catch(() => setAvatarState("idle"))
    },
    [muted]
  )

  const openCallSocket = useCallback((id: string) => {
    const ws = connectCallSocket(id, (event: CallEvent) => {
      if (event.type === "state") {
        if (["listening", "thinking", "speaking", "idle"].includes(event.state)) {
          setAvatarState(event.state as IvrsAvatarState)
        }
      }
    })
    if (!ws) return
    ws.onopen = () => setWsConnected(true)
    ws.onclose = () => setWsConnected(false)
    ws.onerror = () => setWsConnected(false)
    callWsRef.current = ws
  }, [])

  const answer = async () => {
    if (!callId || !incoming) return
    const res = await attendCall(callId)
    if (!res) {
      setErrorMsg("Could not connect the call.")
      return
    }
    setElapsed(0)
    setTranscript([{ role: "aura", text: incoming.message }])
    setPhase("call")
    openCallSocket(callId)
    playAuraLine(callId, incoming.message)
  }

  const decline = async () => {
    if (!callId) return
    await declineCall(callId)
    reset()
  }

  const hangUp = async () => {
    if (!callId) return
    await endCall(callId)
    closeCallSocket()
    setSummaryNote(`Call ended after ${formatTimer(elapsed)}.`)
    setPhase("summary")
  }

  const sendTurn = useCallback(
    async (kind: "text" | "audio", payload: string | Blob) => {
      if (!callId || busy) return
      setBusy(true)
      setAvatarState("thinking")
      const result =
        kind === "text" ? await sendTextTurn(callId, payload as string) : await sendAudioTurn(callId, payload as Blob)

      if (!result.success) {
        setErrorMsg(result.message || "AURA couldn't respond just now. Please try again.")
        setAvatarState("idle")
        setBusy(false)
        return
      }

      setTranscript((t) => {
        const next = [...t]
        if (result.user_text) next.push({ role: "user", text: result.user_text })
        if (result.aura_text) next.push({ role: "aura", text: result.aura_text })
        return next
      })

      if (result.aura_text) playAuraLine(callId, result.aura_text)
      else setAvatarState("idle")
      setBusy(false)
    },
    [callId, busy, playAuraLine]
  )

  const send = () => {
    const text = input.trim()
    if (!text) return
    setInput("")
    sendTurn("text", text)
  }

  const toggleRecording = async () => {
    if (recording) {
      recorderRef.current?.stop()
      setRecording(false)
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      chunksRef.current = []
      recorder.ondataavailable = (e) => chunksRef.current.push(e.data)
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(chunksRef.current, { type: "audio/webm" })
        sendTurn("audio", blob)
      }
      recorder.start()
      recorderRef.current = recorder
      setRecording(true)
    } catch {
      setErrorMsg("Microphone access is required to speak to AURA. You can still type instead.")
      setRecording(false)
    }
  }

  const reset = () => {
    closeCallSocket()
    setIncoming(null)
    setCallId(null)
    setTranscript([])
    setSummaryNote(null)
    setErrorMsg(null)
    setElapsed(0)
    setAvatarState("idle")
    setPhase("idle")
  }

  if (phase === "idle") return null

  return (
    <div className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center p-4">
      <audio
        ref={audioRef}
        className="hidden"
        onEnded={() => setAvatarState("listening")}
        onError={() => setAvatarState("idle")}
      />

      <div className="w-full max-w-md">
        {errorMsg && (
          <div className="flex items-start gap-2 rounded-xl bg-error-container border border-error/40 px-4 py-3 mb-3">
            <AlertTriangle size={15} className="text-error mt-0.5 shrink-0" />
            <p className="text-xs text-on-error-container">{errorMsg}</p>
          </div>
        )}

        {/* ---- Incoming call ---- */}
        {phase === "incoming" && incoming && (
          <section className="rounded-3xl bg-surface-container-lowest border border-outline-variant shadow-2xl p-8 flex flex-col items-center text-center gap-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">📞 AURA Call</p>
            <IvrsAvatar state="ringing" />
            <div>
              <p className="text-[11px] text-on-surface-variant uppercase tracking-wide">Reason</p>
              <p className="text-sm font-medium text-on-surface">
                {incoming.reason_emoji} {incoming.reason_label}
              </p>
            </div>
            <p className="text-sm text-primary font-medium animate-pulse">Incoming Call…</p>
            <div className="flex gap-3 mt-2">
              <button
                onClick={answer}
                className="flex items-center gap-1.5 px-5 py-2.5 rounded-full bg-secondary hover:bg-secondary/90 text-on-secondary text-sm font-semibold"
              >
                <Check size={16} />
                Answer
              </button>
              <button
                onClick={decline}
                className="flex items-center gap-1.5 px-5 py-2.5 rounded-full bg-error hover:bg-error/90 text-on-error text-sm font-semibold"
              >
                <X size={16} />
                Decline
              </button>
            </div>
          </section>
        )}

        {/* ---- Active call ---- */}
        {phase === "call" && (
          <section className="rounded-3xl bg-surface-container-lowest border border-outline-variant shadow-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">AURA Call</p>
              <div className="flex items-center gap-3 text-[11px] text-on-surface-variant">
                <span className={`flex items-center gap-1 ${wsConnected ? "text-secondary" : "text-on-surface-variant/60"}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${wsConnected ? "bg-secondary" : "bg-outline-variant"}`} />
                  {wsConnected ? "Connected" : "Connecting…"}
                </span>
                <span className="tabular-nums font-medium text-on-surface-variant">{formatTimer(elapsed)}</span>
              </div>
            </div>

            <div className="flex justify-center">
              <IvrsAvatar state={avatarState} />
            </div>

            <div ref={scrollRef} className="rounded-xl bg-surface-container-low border border-outline-variant p-3 h-56 overflow-y-auto space-y-2.5">
              {transcript.map((line, i) => (
                <div key={i} className={`flex ${line.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                      line.role === "user"
                        ? "bg-primary text-on-primary rounded-br-sm"
                        : "bg-surface-container-lowest border border-outline-variant text-on-surface-variant rounded-bl-sm"
                    }`}
                  >
                    <p className="text-[10px] uppercase tracking-wide opacity-60 mb-0.5">
                      {line.role === "user" ? "You" : "AURA"}
                    </p>
                    {line.text}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && send()}
                placeholder={recording ? "Listening…" : "Type your reply…"}
                disabled={busy || recording}
                className="flex-1 rounded-full border border-outline-variant px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
              />
              <button
                onClick={toggleRecording}
                disabled={busy}
                title={recording ? "Stop recording" : "Speak to AURA"}
                className={`p-2.5 rounded-full border shrink-0 disabled:opacity-40 ${
                  recording ? "bg-error-container border-error/40 text-on-error-container" : "border-outline-variant text-on-surface-variant hover:bg-surface-container-high"
                }`}
              >
                {recording ? <Square size={16} /> : <Mic size={16} />}
              </button>
              <button
                onClick={send}
                disabled={!input.trim() || busy || recording}
                className="p-2.5 rounded-full bg-primary hover:bg-primary-fixed-dim text-on-primary shrink-0 disabled:opacity-40"
              >
                <Send size={16} />
              </button>
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-outline-variant/50">
              <button
                onClick={() => setMuted((m) => !m)}
                className="flex items-center gap-1.5 text-[11px] text-on-surface-variant hover:text-on-surface"
              >
                {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
                {muted ? "Speaker off" : "Speaker on"}
              </button>
              <button
                onClick={hangUp}
                className="flex items-center gap-1.5 px-4 py-2 rounded-full bg-error hover:bg-error/90 text-on-error text-sm font-semibold"
              >
                <PhoneOff size={14} />
                End Call
              </button>
            </div>
          </section>
        )}

        {/* ---- Summary ---- */}
        {phase === "summary" && (
          <section className="rounded-3xl bg-surface-container-lowest border border-outline-variant shadow-2xl p-8 flex flex-col items-center text-center gap-4">
            <IvrsAvatar state="ended" />
            <p className="text-sm text-on-surface-variant">{summaryNote}</p>
            {transcript.length > 0 && (
              <div className="w-full text-left rounded-xl bg-surface-container-low border border-outline-variant p-3 max-h-48 overflow-y-auto space-y-1.5">
                {transcript.map((line, i) => (
                  <p key={i} className="text-xs text-on-surface-variant">
                    <span className="font-semibold text-on-surface">{line.role === "user" ? "You" : "AURA"}:</span>{" "}
                    {line.text}
                  </p>
                ))}
              </div>
            )}
            <button
              onClick={reset}
              className="px-5 py-2.5 rounded-full bg-primary hover:bg-primary-fixed-dim text-on-primary text-sm font-semibold"
            >
              Close
            </button>
          </section>
        )}
      </div>
    </div>
  )
}
