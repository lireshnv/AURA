import { useEffect, useState } from "react"
import { Plus, X, Phone, Trash2, ShieldCheck } from "lucide-react"
import {
  TrustedContact,
  addTrustedContact,
  deleteTrustedContact,
  fetchSafetyPlan,
  fetchTrustedContacts,
  saveSafetyPlan,
} from "../lib/safetyPlanApi"

/** A simple editable list: add via a text input + button, remove via an X. */
function TagList({
  items,
  onAdd,
  onRemove,
  placeholder,
}: {
  items: string[]
  onAdd: (v: string) => void
  onRemove: (i: number) => void
  placeholder: string
}) {
  const [draft, setDraft] = useState("")
  const submit = () => {
    const v = draft.trim()
    if (!v) return
    onAdd(v)
    setDraft("")
  }
  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-3">
        {items.map((item, i) => (
          <span
            key={`${item}-${i}`}
            className="flex items-center gap-1.5 rounded-full bg-primary-container/10 border border-primary/20 text-on-surface px-3 py-1.5 text-label-md"
          >
            {item}
            <button onClick={() => onRemove(i)} aria-label={`Remove ${item}`} className="text-on-surface-variant hover:text-error">
              <X size={13} />
            </button>
          </span>
        ))}
        {items.length === 0 && <p className="text-label-sm text-on-surface-variant">Nothing added yet.</p>}
      </div>
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder={placeholder}
          className="flex-1 rounded-xl border border-outline-variant bg-surface-container-low px-3.5 py-2 text-body-md text-on-surface outline-none focus:border-primary"
        />
        <button onClick={submit} className="rounded-xl bg-primary text-on-primary px-3.5 flex items-center justify-center">
          <Plus size={17} />
        </button>
      </div>
    </div>
  )
}

export default function SafetyPlan() {
  const [loading, setLoading] = useState(true)
  const [warningSigns, setWarningSigns] = useState<string[]>([])
  const [copingThings, setCopingThings] = useState<string[]>([])
  const [professionalContact, setProfessionalContact] = useState("")
  const [contacts, setContacts] = useState<TrustedContact[]>([])
  const [contactIds, setContactIds] = useState<string[]>([])
  const [newContactName, setNewContactName] = useState("")
  const [newContactRelation, setNewContactRelation] = useState("")
  const [newContactPhone, setNewContactPhone] = useState("")
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  useEffect(() => {
    Promise.all([fetchSafetyPlan(), fetchTrustedContacts()]).then(([planRes, contactsRes]) => {
      if (planRes?.plan) {
        setWarningSigns(planRes.plan.warning_signs)
        setCopingThings(planRes.plan.coping_things)
        setContactIds(planRes.plan.contact_ids)
        setProfessionalContact(planRes.plan.professional_contact ?? "")
      }
      if (contactsRes?.contacts) setContacts(contactsRes.contacts)
      setLoading(false)
    })
  }, [])

  const save = async (overrides?: Partial<{ warning_signs: string[]; coping_things: string[]; contact_ids: string[]; professional_contact: string }>) => {
    setSaving(true)
    const result = await saveSafetyPlan({
      warning_signs: overrides?.warning_signs ?? warningSigns,
      coping_things: overrides?.coping_things ?? copingThings,
      contact_ids: overrides?.contact_ids ?? contactIds,
      professional_contact: (overrides?.professional_contact ?? professionalContact).trim() || null,
    })
    setSaving(false)
    if (result?.plan) setSavedAt(Date.now())
  }

  const addContact = async () => {
    if (!newContactName.trim()) return
    const result = await addTrustedContact({
      name: newContactName.trim(),
      relationship_label: newContactRelation.trim() || null,
      phone: newContactPhone.trim() || null,
      email: null,
      notes: null,
    })
    if (result?.contact) {
      setContacts((prev) => [...prev, result.contact])
      setNewContactName("")
      setNewContactRelation("")
      setNewContactPhone("")
    }
  }

  const removeContact = async (id: string) => {
    await deleteTrustedContact(id)
    setContacts((prev) => prev.filter((c) => c.id !== id))
    const nextIds = contactIds.filter((cid) => cid !== id)
    setContactIds(nextIds)
    save({ contact_ids: nextIds })
  }

  const toggleContactInPlan = (id: string) => {
    const next = contactIds.includes(id) ? contactIds.filter((c) => c !== id) : [...contactIds, id]
    setContactIds(next)
    save({ contact_ids: next })
  }

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto text-center text-body-md text-on-surface-variant py-12">
        Loading your safety plan…
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-stack-lg max-w-2xl mx-auto">
      <header>
        <h1 className="text-headline-lg text-on-surface mb-1 flex items-center gap-2">
          <ShieldCheck size={22} className="text-primary" /> My Safety Plan
        </h1>
        <p className="text-body-lg text-on-surface-variant">
          Yours to edit any time. Nothing here is shared automatically — it's a private reference for you.
        </p>
      </header>

      <section className="bg-surface-container-lowest rounded-[24px] shadow-ambient-md p-stack-md">
        <h2 className="text-headline-md text-on-surface mb-1">My warning signs</h2>
        <p className="text-body-md text-on-surface-variant mb-4">
          Thoughts, feelings or situations that tell you things are getting harder.
        </p>
        <TagList
          items={warningSigns}
          placeholder="e.g. Not sleeping, avoiding calls…"
          onAdd={(v) => {
            const next = [...warningSigns, v]
            setWarningSigns(next)
            save({ warning_signs: next })
          }}
          onRemove={(i) => {
            const next = warningSigns.filter((_, idx) => idx !== i)
            setWarningSigns(next)
            save({ warning_signs: next })
          }}
        />
      </section>

      <section className="bg-surface-container-lowest rounded-[24px] shadow-ambient-md p-stack-md">
        <h2 className="text-headline-md text-on-surface mb-1">Things that help me</h2>
        <p className="text-body-md text-on-surface-variant mb-4">
          Grounding, breathing, a walk, music — whatever actually helps you.
        </p>
        <TagList
          items={copingThings}
          placeholder="e.g. Breathing exercise, calling a friend…"
          onAdd={(v) => {
            const next = [...copingThings, v]
            setCopingThings(next)
            save({ coping_things: next })
          }}
          onRemove={(i) => {
            const next = copingThings.filter((_, idx) => idx !== i)
            setCopingThings(next)
            save({ coping_things: next })
          }}
        />
      </section>

      <section className="bg-surface-container-lowest rounded-[24px] shadow-ambient-md p-stack-md">
        <h2 className="text-headline-md text-on-surface mb-1">People I can contact</h2>
        <p className="text-body-md text-on-surface-variant mb-4">
          AURA never contacts anyone for you — this is just your own list to have ready.
        </p>
        <div className="flex flex-col gap-2 mb-4">
          {contacts.map((c) => (
            <label
              key={c.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-outline-variant bg-surface-container-low px-4 py-3"
            >
              <span className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={contactIds.includes(c.id)}
                  onChange={() => toggleContactInPlan(c.id)}
                  className="w-4 h-4 accent-primary"
                />
                <span>
                  <span className="text-body-md font-medium text-on-surface">{c.name}</span>
                  {c.relationship_label && (
                    <span className="text-label-sm text-on-surface-variant"> — {c.relationship_label}</span>
                  )}
                  {c.phone && (
                    <span className="flex items-center gap-1 text-label-sm text-on-surface-variant mt-0.5">
                      <Phone size={11} /> {c.phone}
                    </span>
                  )}
                </span>
              </span>
              <button onClick={() => removeContact(c.id)} aria-label={`Remove ${c.name}`} className="text-on-surface-variant hover:text-error shrink-0">
                <Trash2 size={15} />
              </button>
            </label>
          ))}
          {contacts.length === 0 && <p className="text-label-sm text-on-surface-variant">No contacts added yet.</p>}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input
            value={newContactName}
            onChange={(e) => setNewContactName(e.target.value)}
            placeholder="Name"
            className="rounded-xl border border-outline-variant bg-surface-container-low px-3.5 py-2 text-body-md text-on-surface outline-none focus:border-primary"
          />
          <input
            value={newContactRelation}
            onChange={(e) => setNewContactRelation(e.target.value)}
            placeholder="Relationship (optional)"
            className="rounded-xl border border-outline-variant bg-surface-container-low px-3.5 py-2 text-body-md text-on-surface outline-none focus:border-primary"
          />
          <div className="flex gap-2">
            <input
              value={newContactPhone}
              onChange={(e) => setNewContactPhone(e.target.value)}
              placeholder="Phone (optional)"
              className="flex-1 rounded-xl border border-outline-variant bg-surface-container-low px-3.5 py-2 text-body-md text-on-surface outline-none focus:border-primary"
            />
            <button onClick={addContact} className="rounded-xl bg-primary text-on-primary px-3.5 flex items-center justify-center">
              <Plus size={17} />
            </button>
          </div>
        </div>
      </section>

      <section className="bg-surface-container-lowest rounded-[24px] shadow-ambient-md p-stack-md">
        <h2 className="text-headline-md text-on-surface mb-1">Professional support</h2>
        <p className="text-body-md text-on-surface-variant mb-4">A counsellor or therapist, if you have one.</p>
        <textarea
          value={professionalContact}
          onChange={(e) => setProfessionalContact(e.target.value)}
          onBlur={() => save()}
          rows={2}
          placeholder="Name and how to reach them…"
          className="w-full rounded-xl border border-outline-variant bg-surface-container-low px-3.5 py-2.5 text-body-md text-on-surface outline-none focus:border-primary resize-none"
        />
      </section>

      <section className="bg-error-container/30 border border-error/30 rounded-[24px] p-stack-md">
        <h2 className="text-headline-md text-on-error-container mb-1">Emergency support</h2>
        <p className="text-body-md text-on-error-container">
          If you're in immediate danger, use the SOS button in the bottom-right corner, or contact{" "}
          <span className="font-semibold">112</span> (emergency) or <span className="font-semibold">14416</span>{" "}
          (Tele-MANAS) directly.
        </p>
      </section>

      <p className="text-label-sm text-on-surface-variant text-center">
        {saving ? "Saving…" : savedAt ? "Saved" : "Changes save automatically."}
      </p>
    </div>
  )
}
