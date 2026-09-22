import { useCallback, useEffect, useRef, useState } from "react"
import {
  Send,
  Mic,
  Square,
  Plus,
  Trash2,
  AlertTriangle,
  LifeBuoy,
  Info,
  Volume2,
} from "lucide-react"
import {
  ChatMessage,
  CompanionStatus,
  SafetyBlock,
  clearConversation,
  fetchCompanionStatus,
  sendChatMessage,
  speakText,
  startNewConversation,
  transcribeVoice,
} from "../lib/chatApi"
import { AvatarAnimationState } from "./AvatarModule/types"
import DailyCare from "./DailyCare"

const LANGUAGE_OPTIONS: { code: string; label: string }[] = [
  { code: "auto", label: "English" },
  { code: "hi", label: "हिन्दी (Hindi)" },
  { code: "bn", label: "বাংলা (Bengali)" },
  { code: "ta", label: "தமிழ் (Tamil)" },
  { code: "te", label: "తెలుగు (Telugu)" },
  { code: "mr", label: "मराठी (Marathi)" },
  { code: "gu", label: "ગુજરાતી (Gujarati)" },
  { code: "kn", label: "ಕನ್ನಡ (Kannada)" },
  { code: "ml", label: "മലയാളം (Malayalam)" },
  { code: "pa", label: "ਪੰਜਾਬੀ (Punjabi)" },
  { code: "ur", label: "اردو (Urdu)" },
]
const LANGUAGE_STORAGE_KEY = "aura_companion_language"

/**
 * AURA AI Companion.
 *
 * Calm and governmental rather than a generic chat clone: no bubbles-on-gradient,
 * restrained typography, a visible statement of what AURA is, and a persistent
 * crisis-support affordance.
 */

/** Minimal, safe Markdown rendering.
 *
 * Deliberately hand-rolled and escape-first rather than pulling in a Markdown
 * library with an HTML passthrough: model output is untrusted input, and the
 * original chatbot rendered it with `innerHTML` via marked.parse(), which is an
 * XSS path if a response ever contains markup.
 */
function renderMarkdown(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")

  return escaped
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, '<code class="px-1 py-0.5 rounded bg-surface-container-high text-[0.9em]">$1</code>')
    .replace(/^[-*] (.+)$/gm, '<li class="ml-4 list-disc">$1</li>')
    .replace(/\n{2,}/g, '</p><p class="mt-2">')
    .replace(/\n/g, "<br/>")
}

function SafetyPanel({ safety }: { safety: SafetyBlock }) {
  const urgent = safety.severity === "urgent"
  return (
    <div
      className={`rounded-xl border px-4 py-3 my-3 ${
        urgent ? "bg-error-container border-error/40" : "bg-amber-50 border-amber-200"
      }`}
      role="alert"
    >
      <div
        className={`flex items-center gap-1.5 text-xs font-semibold mb-1.5 ${
          urgent ? "text-on-error-container" : "text-amber-800"
        }`}
      >
        <LifeBuoy size={13} />
        Support is available right now
      </div>
      <p className={`text-xs mb-2 ${urgent ? "text-on-error-container" : "text-amber-800"}`}>
        {safety.message}
      </p>
      <ul className="space-y-1">
        {safety.resources.map((r) => (
          <li key={r.label} className="text-[11px] text-on-surface-variant">
            <span className="font-medium">{r.label}</span> — {r.detail}
          </li>
        ))}
      </ul>
    </div>
  )
}

export default function AICompanion() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [safetyBlocks, setSafetyBlocks] = useState<Record<number, SafetyBlock>>({})
  const [input, setInput] = useState("")
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [status, setStatus] = useState<CompanionStatus | null>(null)
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [supportive, setSupportive] = useState(false)
  const [language, setLanguage] = useState<string>(() => {
    try {
      return localStorage.getItem(LANGUAGE_STORAGE_KEY) || "auto"
    } catch {
      return "auto"
    }
  })

  const changeLanguage = (code: string) => {
    setLanguage(code)
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, code)
    } catch {
      /* per-browser convenience only - conversation works without it */
    }
  }

  const scrollRef = useRef<HTMLDivElement>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const audioRef = useRef<HTMLAudioElement>(null)

  useEffect(() => {
    fetchCompanionStatus().then(setStatus)
    startNewConversation().then(setSessionId)
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
  }, [messages, sending])

  const playReply = useCallback(
    async (text: string) => {
      if (!status?.tts_available) return
      const url = await speakText(text)
      if (!url || !audioRef.current) return
      audioRef.current.src = url
      try {
        await audioRef.current.play()
      } catch {
        /* autoplay blocked or playback failed - the text reply already shown */
      }
    },
    [status?.tts_available]
  )

  const send = useCallback(
    async (text: string) => {
      if (!text.trim() || sending) return

      setInput("")
      setMessages((m) => [...m, { role: "user", content: text }])
      setSending(true)

      const reply = await sendChatMessage(text, sessionId, language)
      if (reply.session_id) setSessionId(reply.session_id)

      setSupportive(!!reply.safety?.triggered)
      setMessages((m) => {
        const next = [...m, { role: "assistant" as const, content: reply.response }]
        if (reply.safety?.triggered) {
          setSafetyBlocks((s) => ({ ...s, [next.length - 1]: reply.safety! }))
        }
        return next
      })
      setSending(false)
      if (reply.status === "success") playReply(reply.response)
    },
    [sending, sessionId, playReply, language]
  )

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
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(chunksRef.current, { type: "audio/webm" })
        setTranscribing(true)
        const text = await transcribeVoice(blob)
        setTranscribing(false)
        if (text) send(text)
      }
      recorder.start()
      recorderRef.current = recorder
      setRecording(true)
    } catch {
      setRecording(false)
    }
  }

  const reset = async () => {
    if (sessionId) await clearConversation(sessionId)
    const fresh = await startNewConversation()
    setSessionId(fresh)
    setMessages([])
    setSafetyBlocks({})
    setSupportive(false)
  }

  const unavailable = status && !status.ready

  const avatarAnimation: AvatarAnimationState = recording
    ? "listening"
    : sending || transcribing
    ? "thinking"
    : speaking
    ? "talking"
    : supportive
    ? "concerned"
    : "idle"

  return (
    <div className="space-y-4">
      <audio
        ref={audioRef}
        className="hidden"
        onPlay={() => setSpeaking(true)}
        onEnded={() => setSpeaking(false)}
        onPause={() => setSpeaking(false)}
        onError={() => setSpeaking(false)}
      />

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-headline-md text-on-surface">AI Companion</h1>
          <p className="text-body-md text-on-surface-variant mt-0.5">
            A private space to talk. You can share as much or as little as you want.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <select
            value={language}
            onChange={(e) => changeLanguage(e.target.value)}
            title="Reply language"
            className="px-2 py-1.5 rounded-lg border border-outline-variant text-xs text-on-surface-variant bg-surface-container-lowest hover:bg-surface-container-low"
          >
            {LANGUAGE_OPTIONS.map((opt) => (
              <option key={opt.code} value={opt.code}>
                {opt.label}
              </option>
            ))}
          </select>
          <button
            onClick={reset}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-outline-variant text-xs text-on-surface-variant hover:bg-surface-container-high"
          >
            <Plus size={13} />
            New
          </button>
          {messages.length > 0 && (
            <button
              onClick={reset}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-outline-variant text-xs text-on-surface-variant hover:bg-surface-container-high"
            >
              <Trash2 size={13} />
              Clear
            </button>
          )}
        </div>
      </div>

      {unavailable && (
        <div className="flex items-start gap-2 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3">
          <AlertTriangle size={15} className="text-amber-600 mt-0.5 shrink-0" />
          <div>
            <p className="text-xs font-medium text-amber-800">Companion not configured</p>
            <p className="text-[11px] text-amber-700 mt-0.5">{status?.note}</p>
          </div>
        </div>
      )}

      <section className="rounded-xl bg-surface-container-lowest border border-outline-variant overflow-hidden flex flex-col h-[600px]">
        <div className="px-5 py-3 border-b border-outline-variant text-center">
          {messages.length === 0 ? (
            <p className="text-sm font-semibold text-on-surface">How are you feeling today?</p>
          ) : (
            <p className="text-[11px] text-on-surface-variant capitalize">{avatarAnimation}</p>
          )}
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4">
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center px-6">
              <p className="text-sm text-on-surface-variant max-w-sm">
                Start a conversation with AURA. There's no right way to begin, and you
                can stop at any time.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {messages.map((m, i) => (
                <div key={i}>
                  {m.role === "user" ? (
                    <div className="flex justify-end">
                      <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-primary text-on-primary px-4 py-2.5 text-sm whitespace-pre-wrap">
                        {m.content}
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-3">
                      <div className="w-7 h-7 rounded-full bg-primary-container/10 border border-primary/20 flex items-center justify-center shrink-0 mt-0.5">
                        <span className="text-primary font-bold text-[11px]">A</span>
                      </div>
                      <div
                        className="max-w-[85%] text-sm text-on-surface-variant leading-relaxed [&_strong]:text-on-surface [&_li]:my-0.5"
                        dangerouslySetInnerHTML={{
                          __html: `<p>${renderMarkdown(m.content)}</p>`,
                        }}
                      />
                    </div>
                  )}
                  {safetyBlocks[i] && <SafetyPanel safety={safetyBlocks[i]} />}
                </div>
              ))}
              {sending && (
                <div className="flex gap-3 items-center">
                  <div className="w-7 h-7 rounded-full bg-primary-container/10 border border-primary/20 flex items-center justify-center shrink-0">
                    <span className="text-primary font-bold text-[11px]">A</span>
                  </div>
                  <span className="text-xs text-on-surface-variant italic">AURA is typing…</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="border-t border-outline-variant px-4 py-3">
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault()
                  send(input)
                }
              }}
              rows={1}
              placeholder={recording ? "Listening…" : transcribing ? "Transcribing…" : "Type your message…"}
              className="flex-1 resize-none rounded-lg border border-outline-variant px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:ring-2 focus:ring-primary max-h-32"
            />
            <button
              onClick={toggleRecording}
              disabled={transcribing}
              title={recording ? "Stop recording" : "Start voice input"}
              className={`p-2.5 rounded-lg border shrink-0 disabled:opacity-40 ${
                recording
                  ? "bg-error-container border-error/40 text-on-error-container"
                  : "border-outline-variant text-on-surface-variant hover:bg-surface-container-high"
              }`}
            >
              {recording ? <Square size={16} /> : <Mic size={16} />}
            </button>
            <button
              onClick={() => send(input)}
              disabled={!input.trim() || sending}
              className="p-2.5 rounded-lg bg-primary hover:bg-primary-fixed-dim text-on-primary shrink-0 disabled:opacity-40"
            >
              <Send size={16} />
            </button>
          </div>
          <p className="flex items-center gap-1.5 text-[10px] text-on-surface-variant mt-2">
            {status?.tts_available ? (
              <Volume2 size={10} />
            ) : (
              <Info size={10} />
            )}
            AURA is an AI companion and does not replace professional care. If you are in
            danger, please contact your local emergency number.
          </p>
        </div>
      </section>

      <DailyCare />
    </div>
  )
}
