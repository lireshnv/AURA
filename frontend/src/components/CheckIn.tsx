import { useRef, useState } from "react"
import { Mic, Square, ArrowRight, Check } from "lucide-react"
import { submitCheckin } from "../lib/twinApi"
import { transcribeVoice } from "../lib/chatApi"

type Step = "feeling" | "context" | "note" | "response"

interface FeelingOption {
  key: string
  label: string
  emoji: string
  moodScore: number | null
}

const FEELINGS: FeelingOption[] = [
  { key: "good", label: "Good", emoji: "🙂", moodScore: 8 },
  { key: "okay", label: "Okay", emoji: "😐", moodScore: 6 },
  { key: "low", label: "Low", emoji: "😔", moodScore: 3 },
  { key: "anxious", label: "Anxious", emoji: "😟", moodScore: 3 },
  { key: "angry", label: "Angry", emoji: "😡", moodScore: 2 },
  { key: "exhausted", label: "Exhausted", emoji: "😴", moodScore: 3 },
]

const CATEGORIES = [
  "Work / Studies",
  "Family",
  "Relationships",
  "Sleep",
  "Physical health",
  "Financial concerns",
  "Memories / difficult experiences",
  "Something else",
]

/**
 * Deterministic acknowledgement + 1-3 next steps from what was just
 * selected. Not a model call - this is UI copy, not an analytic claim, so it
 * stays simple and honest about only reflecting what the user chose.
 */
function respondTo(feeling: FeelingOption | null, categories: string[], hasNote: boolean) {
  const heavy = feeling && ["low", "anxious", "angry", "exhausted"].includes(feeling.key)
  const mentionsPeople = categories.some((c) => c === "Family" || c === "Relationships")

  let ack: string
  if (!feeling) {
    ack = "Thanks for checking in."
  } else if (heavy) {
    ack = hasNote
      ? "Thanks for sharing that. It sounds like today has been heavier than usual."
      : `Thanks for checking in. Feeling ${feeling.label.toLowerCase()} is worth paying attention to.`
  } else {
    ack = "Thanks for checking in — good to hear things are steady today."
  }

  type Action = { label: string; key: "companion" | "support" | "note" | "contact" }
  const actions: Action[] = []
  if (heavy) {
    actions.push({ label: "Take a breathing break", key: "support" })
    actions.push({ label: "Talk with Aura", key: "companion" })
    if (mentionsPeople) actions.push({ label: "Contact someone you trust", key: "contact" })
    else if (!hasNote) actions.push({ label: "Write it out", key: "note" })
  } else {
    actions.push({ label: "Talk with Aura", key: "companion" })
    actions.push({ label: "Browse support resources", key: "support" })
  }
  return { ack, actions: actions.slice(0, 3) }
}

interface Props {
  onDone: () => void
  onOpenCompanion: () => void
  onOpenSupport: () => void
}

export default function CheckIn({ onDone, onOpenCompanion, onOpenSupport }: Props) {
  const [step, setStep] = useState<Step>("feeling")
  const [feeling, setFeeling] = useState<FeelingOption | null>(null)
  const [otherLabel, setOtherLabel] = useState("")
  const [pickedOther, setPickedOther] = useState(false)
  const [categories, setCategories] = useState<string[]>([])
  const [note, setNote] = useState("")
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  const feelingLabel = pickedOther ? otherLabel.trim() || "Something else" : feeling?.label ?? null

  const toggleCategory = (c: string) =>
    setCategories((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]))

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
        if (text) setNote((prev) => (prev ? `${prev} ${text}` : text))
      }
      recorder.start()
      recorderRef.current = recorder
      setRecording(true)
    } catch {
      setRecording(false)
    }
  }

  const submit = async () => {
    setSubmitting(true)
    try {
      await submitCheckin({
        ...(feeling?.moodScore != null ? { mood: feeling.moodScore } : {}),
        feeling: feelingLabel ?? "Not specified",
        categories,
        note: note.trim() || undefined,
        skipped: false,
      })
    } catch {
      // A failed write must never block the supportive response that follows.
    } finally {
      setSubmitting(false)
      setSubmitted(true)
      setStep("response")
    }
  }

  const { ack, actions } = respondTo(pickedOther ? { key: "other", label: "Something else", emoji: "", moodScore: null } : feeling, categories, note.trim().length > 0)

  const actionHandler = (key: string) => {
    if (key === "companion") onOpenCompanion()
    else if (key === "support") onOpenSupport()
    else if (key === "note") setStep("note")
    else if (key === "contact") onOpenSupport()
  }

  const StepDots = () => (
    <div className="flex items-center gap-1.5 mb-6" aria-hidden="true">
      {(["feeling", "context", "note", "response"] as Step[]).map((s) => (
        <span
          key={s}
          className={`h-1.5 rounded-full transition-all ${
            s === step ? "w-6 bg-primary" : "w-1.5 bg-outline-variant"
          }`}
        />
      ))}
    </div>
  )

  return (
    <div className="max-w-xl mx-auto">
      <div className="bg-surface-container-lowest rounded-[24px] shadow-ambient-md p-stack-md">
        <StepDots />

        {step === "feeling" && (
          <>
            <h1 className="text-headline-lg text-on-surface mb-1">How are you feeling?</h1>
            <p className="text-body-md text-on-surface-variant mb-6">
              Pick whatever feels closest right now.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
              {FEELINGS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => {
                    setFeeling(f)
                    setPickedOther(false)
                    setStep("context")
                  }}
                  className="flex flex-col items-center gap-2 rounded-2xl border border-outline-variant bg-surface-container-low hover:border-primary hover:bg-primary-container/10 transition-colors py-5"
                >
                  <span className="text-3xl">{f.emoji}</span>
                  <span className="text-label-md text-on-surface font-medium">{f.label}</span>
                </button>
              ))}
            </div>
            {!pickedOther ? (
              <button
                onClick={() => setPickedOther(true)}
                className="text-label-md text-on-surface-variant underline underline-offset-2 hover:text-primary"
              >
                Other
              </button>
            ) : (
              <div className="flex gap-2">
                <input
                  autoFocus
                  value={otherLabel}
                  onChange={(e) => setOtherLabel(e.target.value)}
                  placeholder="Describe it in a word or two"
                  className="flex-1 rounded-xl border border-outline-variant bg-surface-container-low px-4 py-2.5 text-body-md text-on-surface outline-none focus:border-primary"
                />
                <button
                  disabled={!otherLabel.trim()}
                  onClick={() => setStep("context")}
                  className="rounded-xl bg-primary text-on-primary px-4 py-2.5 text-label-md font-semibold disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}

        {step === "context" && (
          <>
            <h1 className="text-headline-lg text-on-surface mb-1">What's affecting you?</h1>
            <p className="text-body-md text-on-surface-variant mb-6">Optional — pick as many as apply.</p>
            <div className="flex flex-wrap gap-2 mb-8">
              {CATEGORIES.map((c) => (
                <button
                  key={c}
                  onClick={() => toggleCategory(c)}
                  className={`rounded-full border px-4 py-2 text-label-md transition-colors ${
                    categories.includes(c)
                      ? "bg-primary text-on-primary border-primary"
                      : "border-outline-variant text-on-surface-variant hover:border-primary"
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
            <div className="flex justify-between">
              <button
                onClick={() => setStep("note")}
                className="text-label-md text-on-surface-variant hover:text-primary"
              >
                Skip
              </button>
              <button
                onClick={() => setStep("note")}
                className="flex items-center gap-1.5 rounded-xl bg-primary text-on-primary px-5 py-2.5 text-label-md font-semibold"
              >
                Continue <ArrowRight size={16} />
              </button>
            </div>
          </>
        )}

        {step === "note" && (
          <>
            <h1 className="text-headline-lg text-on-surface mb-1">Want to tell Aura a little more?</h1>
            <p className="text-body-md text-on-surface-variant mb-6">Optional — type or speak, whichever is easier.</p>
            <div className="relative mb-8">
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={4}
                placeholder={recording ? "Listening…" : transcribing ? "Transcribing…" : "Whatever you'd like to share…"}
                className="w-full rounded-xl border border-outline-variant bg-surface-container-low px-4 py-3 text-body-md text-on-surface outline-none focus:border-primary resize-none"
              />
              <button
                onClick={toggleRecording}
                title={recording ? "Stop recording" : "Start voice input"}
                className={`absolute right-3 bottom-3 w-9 h-9 rounded-full flex items-center justify-center transition-colors ${
                  recording ? "bg-error text-on-error" : "bg-primary-container/20 text-primary hover:bg-primary-container/30"
                }`}
              >
                {recording ? <Square size={15} /> : <Mic size={15} />}
              </button>
            </div>
            <div className="flex justify-between">
              <button
                onClick={submit}
                disabled={submitting}
                className="text-label-md text-on-surface-variant hover:text-primary disabled:opacity-40"
              >
                Skip
              </button>
              <button
                onClick={submit}
                disabled={submitting}
                className="flex items-center gap-1.5 rounded-xl bg-primary text-on-primary px-5 py-2.5 text-label-md font-semibold disabled:opacity-60"
              >
                {submitting ? "Saving…" : "Continue"} <ArrowRight size={16} />
              </button>
            </div>
          </>
        )}

        {step === "response" && (
          <>
            <div className="flex items-center gap-2 text-secondary mb-4">
              <Check size={18} />
              <span className="text-label-md font-semibold">{submitted ? "Check-in saved" : "Noted"}</span>
            </div>
            <h1 className="text-headline-lg text-on-surface mb-2">{ack}</h1>
            <p className="text-body-md text-on-surface-variant mb-6">
              Here's what might help right now.
            </p>
            <div className="flex flex-col gap-3 mb-8">
              {actions.map((a) => (
                <button
                  key={a.key}
                  onClick={() => actionHandler(a.key)}
                  className="text-left rounded-xl border border-outline-variant bg-surface-container-low hover:border-primary hover:bg-primary-container/10 px-4 py-3.5 text-body-md text-on-surface font-medium transition-colors"
                >
                  {a.label}
                </button>
              ))}
            </div>
            <button onClick={onDone} className="text-label-md text-on-surface-variant hover:text-primary">
              I'm done for now
            </button>
          </>
        )}
      </div>
    </div>
  )
}
