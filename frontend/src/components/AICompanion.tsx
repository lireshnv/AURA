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
  VolumeX,
  Bone,
  Droplets,
  HeartHandshake,
  Sparkles,
} from "lucide-react"
import { SafetyBlock, transcribeVoice } from "../lib/chatApi"
import { useAuraConversation } from "../lib/useAuraConversation"
import { LANGUAGE_OPTIONS, getStoredLanguage, storeLanguage } from "../lib/companionLanguages"
import {
  CareActivityType,
  CareSummary,
  fetchCareToday,
  setConsent,
  submitCareAction,
  submitCheckin,
} from "../lib/twinApi"
import AvatarModule from "./AvatarModule"
import { useAvatarIdentity } from "./AvatarModule/useAvatarIdentity"
import { AvatarAnimationState, Expression } from "./AvatarModule/types"
import { ActivityModal, CareReactionPanel, ReactionKind } from "./DailyCare"

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
export function renderMarkdown(text: string): string {
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

const SOUND_KEY = "aura-companion-sound"

/** A tiny synthesized chirp (no audio asset) for a pet/feed/check-in
 * reaction - shared AudioContext so repeated taps don't leak nodes. */
let boopCtx: AudioContext | null = null
function playBoop(freq = 660) {
  try {
    boopCtx ??= new AudioContext()
    if (boopCtx.state === "suspended") boopCtx.resume().catch(() => {})
    const osc = boopCtx.createOscillator()
    const gain = boopCtx.createGain()
    osc.type = "sine"
    osc.frequency.setValueAtTime(freq, boopCtx.currentTime)
    osc.frequency.exponentialRampToValueAtTime(freq * 1.5, boopCtx.currentTime + 0.09)
    gain.gain.setValueAtTime(0.08, boopCtx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, boopCtx.currentTime + 0.16)
    osc.connect(gain).connect(boopCtx.destination)
    osc.start()
    osc.stop(boopCtx.currentTime + 0.17)
  } catch {
    /* best-effort - a silent companion is still a working one */
  }
}

const EXPRESSION_PICKS: { value: Expression; emoji: string; label: string }[] = [
  { value: "natural", emoji: "🙂", label: "Natural" },
  { value: "happy", emoji: "😄", label: "Happy" },
  { value: "calm", emoji: "😌", label: "Calm" },
  { value: "surprised", emoji: "😮", label: "Surprised" },
]

export function SafetyPanel({ safety }: { safety: SafetyBlock }) {
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
  const [input, setInput] = useState("")
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [language, setLanguage] = useState<string>(getStoredLanguage)
  const [showTranscript, setShowTranscript] = useState(false)
  const [pokeReaction, setPokeReaction] = useState<AvatarAnimationState | null>(null)
  const [petting, setPetting] = useState(false)
  const [expression, setExpression] = useState<Expression>("natural")
  const [soundOn, setSoundOn] = useState(() => {
    try {
      return localStorage.getItem(SOUND_KEY) !== "off"
    } catch {
      return true
    }
  })

  const toggleSound = () => {
    setSoundOn((v) => {
      const next = !v
      try {
        localStorage.setItem(SOUND_KEY, next ? "on" : "off")
      } catch {
        /* preference just won't persist */
      }
      return next
    })
  }

  const { avatarType } = useAvatarIdentity()
  const isPlant = avatarType === "plant"
  const [careSummary, setCareSummary] = useState<CareSummary | null>(null)
  const [showActivity, setShowActivity] = useState(false)
  const [checkinBusy, setCheckinBusy] = useState(false)
  const [carePanel, setCarePanel] = useState<ReactionKind | null>(null)

  const changeLanguage = (code: string) => {
    setLanguage(code)
    storeLanguage(code)
  }

  const scrollRef = useRef<HTMLDivElement>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  const {
    messages,
    safetyBlocks,
    sending,
    speaking,
    supportive,
    status,
    send: sendRaw,
    reset: resetConversation,
  } = useAuraConversation(language)

  const send = async (text: string) => {
    if (!text.trim() || sending) return
    setInput("")
    await sendRaw(text)
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
  }, [messages, sending])

  const loadCare = useCallback(() => {
    fetchCareToday().then(setCareSummary)
  }, [])

  useEffect(() => {
    loadCare()
  }, [loadCare])

  const enableCare = async () => {
    await setConsent("companion_care", true)
    loadCare()
  }

  const doCareAction = async (kind: "feed" | "water") => {
    if (!careSummary?.consent) await enableCare()
    const result = await submitCareAction(kind)
    if (result.success) {
      setCareSummary(result as CareSummary)
      poke()
      setCarePanel(kind)
    }
  }

  const doCheckin = async () => {
    setCheckinBusy(true)
    await setConsent("checkins", true)
    // A neutral single-value quick check-in - the full questionnaire lives in
    // My Wellbeing; this only records that a check-in happened today.
    await submitCheckin({ mood: 5 })
    await loadCare()
    setCheckinBusy(false)
    poke()
  }

  const completeActivity = async (type: CareActivityType) => {
    if (!careSummary?.consent) await enableCare()
    const result = await submitCareAction("activity", type)
    if (result.success) setCareSummary(result as CareSummary)
    setShowActivity(false)
    poke()
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

  const reset = resetConversation

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

  // A poke/pet briefly overrides the live conversation state so touching the
  // companion always feels acknowledged, then hands control back.
  const effectiveAnimation: AvatarAnimationState = petting ? "greeting" : pokeReaction ?? avatarAnimation

  const poke = () => {
    if (soundOn) playBoop()
    if (pokeReaction) return
    setPokeReaction("greeting")
    window.setTimeout(() => setPokeReaction(null), 1600)
  }

  const startPetting = () => {
    setPetting(true)
    if (soundOn) playBoop(520)
  }
  const stopPetting = () => setPetting(false)

  const lastAssistantMessage = [...messages].reverse().find((m) => m.role === "assistant")

  // A real, data-driven nudge (not a fake streak/gamification prompt) - only
  // shown when today's check-in genuinely hasn't happened yet.
  const needsCheckinToday = !!careSummary && careSummary.consent && !careSummary.today.checkin
  const statusText =
    messages.length === 0
      ? needsCheckinToday
        ? "Haven't checked in today - tap Check-in below, or just say hello"
        : "Say hello, or tap your companion"
      : lastAssistantMessage?.content
      ? ""
      : "Listening…"

  return (
    <div className="space-y-4">
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

      {/* Companion stage: the avatar leads, the chat log lives underneath it */}
      <section className="rounded-[24px] bg-surface-container-lowest border border-outline-variant overflow-hidden">
        <div className="px-5 pt-4 pb-1 flex items-center justify-between gap-3">
          <p className="text-sm font-semibold text-on-surface">{statusText}</p>
          <div className="flex items-center gap-2 shrink-0">
            {!isPlant && careSummary && careSummary.care_streak_days > 0 && (
              <span className="flex items-center gap-1 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
                <Sparkles size={11} />
                {careSummary.care_streak_days}-day streak
              </span>
            )}
            <p className="text-[11px] text-on-surface-variant capitalize">{effectiveAnimation}</p>
            <button
              onClick={toggleSound}
              title={soundOn ? "Mute companion sounds" : "Unmute companion sounds"}
              className="w-6 h-6 rounded-full flex items-center justify-center text-on-surface-variant hover:bg-surface-container-high"
            >
              {soundOn ? <Volume2 size={13} /> : <VolumeX size={13} />}
            </button>
          </div>
        </div>

        <div className="relative">
          <div
            role="button"
            tabIndex={0}
            title="Tap or hold to pet - drag to look around"
            onClick={poke}
            onPointerDown={startPetting}
            onPointerUp={stopPetting}
            onPointerLeave={stopPetting}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault()
                poke()
              }
            }}
            className="w-full h-80 md:h-[28rem] px-5 pb-2 cursor-pointer"
          >
            <AvatarModule
              drivenAnimation={effectiveAnimation}
              expression={expression}
              compact
              showSwitcher
              interactive
            />
          </div>
          {carePanel && <CareReactionPanel kind={carePanel} onDone={() => setCarePanel(null)} />}
        </div>

        {/* Purely playful - lets you set how the companion looks, with no
            effect on the app's actual data or state. */}
        <div className="flex items-center gap-1.5 px-5 pt-1 pb-3">
          {EXPRESSION_PICKS.map((p) => (
            <button
              key={p.value}
              onClick={() => setExpression(p.value)}
              title={p.label}
              className={`w-8 h-8 rounded-full flex items-center justify-center text-base transition-colors ${
                expression === p.value
                  ? "bg-primary-container/25 ring-2 ring-primary"
                  : "hover:bg-surface-container-high"
              }`}
            >
              {p.emoji}
            </button>
          ))}
        </div>

        {careSummary && !careSummary.consent && (
          <div className="mx-5 mb-3 rounded-lg bg-violet-50 border border-violet-200 px-3 py-2 text-xs text-violet-800 flex items-center justify-between gap-3">
            <span>Turn on Daily Care to have AURA reflect your real completed actions.</span>
            <button
              onClick={enableCare}
              className="shrink-0 px-2.5 py-1 rounded-lg bg-violet-600 text-white text-[11px]"
            >
              Enable
            </button>
          </div>
        )}

        {/* Play with your companion: feed/water, check-in, an activity */}
        <div className="grid grid-cols-3 gap-2 px-5 pb-4">
          {needsCheckinToday && (
            <span className="col-span-3 -mt-1 mb-0.5 text-[10px] text-on-surface-variant">
              Today's check-in is still open
            </span>
          )}
          {isPlant ? (
            <button
              onClick={() => doCareAction("water")}
              className="flex flex-col items-center gap-1 rounded-xl border border-outline-variant py-2.5 hover:bg-surface-container-high"
            >
              <Droplets size={17} className="text-sky-600" />
              <span className="text-[11px] text-on-surface-variant">Water</span>
            </button>
          ) : (
            <button
              onClick={() => doCareAction("feed")}
              className="flex flex-col items-center gap-1 rounded-xl border border-outline-variant py-2.5 hover:bg-surface-container-high"
            >
              <Bone size={17} className="text-amber-600" />
              <span className="text-[11px] text-on-surface-variant">Feed</span>
            </button>
          )}
          <button
            onClick={doCheckin}
            disabled={checkinBusy}
            className="flex flex-col items-center gap-1 rounded-xl border border-outline-variant py-2.5 hover:bg-surface-container-high disabled:opacity-50"
          >
            <HeartHandshake size={17} className="text-rose-600" />
            <span className="text-[11px] text-on-surface-variant">Check-in</span>
          </button>
          <button
            onClick={() => setShowActivity(true)}
            className="flex flex-col items-center gap-1 rounded-xl border border-outline-variant py-2.5 hover:bg-surface-container-high"
          >
            <Sparkles size={17} className="text-violet-600" />
            <span className="text-[11px] text-on-surface-variant">Activity</span>
          </button>
        </div>

        {!showTranscript && lastAssistantMessage && (
          <div className="px-5 pb-3">
            <p className="text-xs text-on-surface-variant italic line-clamp-2">
              "{lastAssistantMessage.content.replace(/[*`_]/g, "").slice(0, 220)}"
            </p>
          </div>
        )}

        <button
          onClick={() => setShowTranscript((v) => !v)}
          className="w-full text-center text-[11px] font-medium text-primary py-2.5 border-t border-outline-variant hover:bg-surface-container-high"
        >
          {showTranscript ? "Hide conversation" : `View conversation${messages.length ? ` (${messages.length})` : ""}`}
        </button>

        {showTranscript && (
          <div ref={scrollRef} className="max-h-72 overflow-y-auto px-5 py-4 border-t border-outline-variant">
            {messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center px-6 py-8">
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
        )}
      </section>

      {/* Composer: speak or type to your companion, always reachable */}
      <div className="rounded-xl bg-surface-container-lowest border border-outline-variant px-4 py-3">
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

      {showActivity && (
        <ActivityModal onClose={() => setShowActivity(false)} onComplete={completeActivity} />
      )}
    </div>
  )
}
