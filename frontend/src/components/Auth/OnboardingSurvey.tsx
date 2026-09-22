import { useState } from "react"
import { Loader2 } from "lucide-react"
import { Role, submitOnboarding } from "../../lib/authApi"

interface Question {
  id: string
  prompt: string
  placeholder?: string
}

// Short by design - every field is optional, matching the app's existing
// check-in ethos elsewhere ("skip anything you'd rather not answer").
const QUESTIONS: Record<Role, Question[]> = {
  victim: [
    { id: "goal", prompt: "What are you hoping AURA can help with?", placeholder: "Optional" },
  ],
  counsellor: [
    { id: "title", prompt: "Your professional title or role", placeholder: "e.g. Licensed counsellor" },
    { id: "focus", prompt: "Primary area of focus", placeholder: "Optional" },
  ],
  admin: [{ id: "team", prompt: "Team or department", placeholder: "Optional" }],
  guardian: [
    { id: "relationship", prompt: "Your relationship to the person you support", placeholder: "e.g. Parent, sibling" },
  ],
}

const ROLE_INTRO: Record<Role, string> = {
  victim: "A couple of quick questions before your dashboard.",
  counsellor: "A short setup step before you review cases.",
  admin: "One quick step before the admin dashboard.",
  guardian: "One quick step before your dashboard.",
}

export default function OnboardingSurvey({ role, onComplete }: { role: Role; onComplete: () => void }) {
  const questions = QUESTIONS[role]
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const finish = async () => {
    setBusy(true)
    const responses = Object.fromEntries(
      Object.entries(answers).filter(([, v]) => v.trim().length > 0)
    )
    await submitOnboarding(responses)
    setBusy(false)
    onComplete()
  }

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm bg-surface-container-lowest rounded-[24px] card-shadow p-6">
        <h1 className="text-headline-md text-on-surface font-bold mb-1">Welcome to AURA</h1>
        <p className="text-label-md text-on-surface-variant mb-5">{ROLE_INTRO[role]}</p>

        <div className="space-y-4">
          {questions.map((q) => (
            <div key={q.id}>
              <label className="block text-label-md text-on-surface mb-1.5">{q.prompt}</label>
              <input
                value={answers[q.id] ?? ""}
                onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                placeholder={q.placeholder}
                className="w-full rounded-lg border border-outline-variant px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
          ))}
        </div>

        <div className="flex gap-2 mt-6">
          <button
            onClick={finish}
            disabled={busy}
            className="flex-1 py-2.5 rounded-full bg-primary hover:bg-primary-fixed-dim text-on-primary text-label-md font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {busy && <Loader2 size={15} className="animate-spin" />}
            Continue
          </button>
          <button
            onClick={finish}
            disabled={busy}
            className="px-4 py-2.5 rounded-full border border-outline-variant text-on-surface-variant text-label-md"
          >
            Skip
          </button>
        </div>
      </div>
    </div>
  )
}
