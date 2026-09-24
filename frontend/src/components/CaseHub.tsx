import { useEffect, useState } from "react"
import {
  FolderLock,
  Scale,
  Phone,
  ShieldCheck,
  Landmark,
  HeartHandshake,
  Users as UsersIcon,
  Plus,
  ExternalLink,
} from "lucide-react"
import CaseDocuments from "./CaseDocuments"
import HistoryPage from "./HistoryPage"
import {
  CaseStage,
  CaseStageOptions,
  CaseTypeRecord,
  CaseUpdateRecord,
  InterventionRecord,
  MyCounsellorRecord,
  createCaseUpdate,
  fetchCaseStageOptions,
  fetchCaseType,
  fetchCaseUpdates,
  fetchMyCounsellor,
  fetchSupportHistory,
} from "../lib/auraApi"
import { fetchTrustedContacts, TrustedContact } from "../lib/safetyPlanApi"

type Tab = "overview" | "timeline" | "documents" | "people" | "updates" | "support" | "sessions"

const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "timeline", label: "Timeline" },
  { key: "sessions", label: "Sessions" },
  { key: "documents", label: "Documents" },
  { key: "people", label: "People" },
  { key: "updates", label: "Updates" },
  { key: "support", label: "Support" },
]

const STAGE_ORDER: CaseStage[] = ["complaint", "investigation", "trial", "rehabilitation", "compensation"]

const STATUS_COPY: Record<string, { label: string; tone: string }> = {
  approved: { label: "Approved — being arranged for you", tone: "text-secondary" },
  rejected: { label: "Reviewed — this path wasn't taken forward", tone: "text-on-surface-variant" },
  escalated: { label: "Escalated for closer attention", tone: "text-primary" },
  recommended: { label: "Suggested — awaiting review", tone: "text-tertiary" },
  in_progress: { label: "In progress", tone: "text-primary" },
  completed: { label: "Completed", tone: "text-secondary" },
}

const CATEGORY_LABEL: Record<string, string> = {
  general: "General", stage: "Case stage", investigation: "Investigation", hearing: "Hearing",
  officer: "Officer", protection: "Protection", compensation: "Compensation",
  rehabilitation: "Rehabilitation", counselling: "Counselling", support: "Support", document: "Document",
}

function StageJourney({ stage }: { stage: CaseStage }) {
  if (stage === "closed") {
    return (
      <div className="flex items-center gap-2 text-label-md font-semibold text-on-surface-variant">
        <ShieldCheck size={16} /> Case closed
      </div>
    )
  }
  const currentIdx = STAGE_ORDER.indexOf(stage)
  return (
    <div className="flex items-center w-full overflow-x-auto pb-1">
      {STAGE_ORDER.map((s, i) => {
        const done = i < currentIdx
        const active = i === currentIdx
        return (
          <div key={s} className="flex items-center shrink-0">
            <div className="flex flex-col items-center gap-1.5 min-w-[92px]">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-label-sm font-bold border-2 ${
                  active
                    ? "bg-primary text-on-primary border-primary"
                    : done
                    ? "bg-secondary-container/30 text-secondary border-secondary/40"
                    : "bg-surface-container-low text-on-surface-variant border-outline-variant"
                }`}
              >
                {i + 1}
              </div>
              <span className={`text-label-sm text-center capitalize ${active ? "font-bold text-on-surface" : "text-on-surface-variant"}`}>
                {s}
              </span>
            </div>
            {i < STAGE_ORDER.length - 1 && (
              <div className={`h-0.5 w-10 mb-5 ${i < currentIdx ? "bg-secondary/50" : "bg-outline-variant"}`} />
            )}
          </div>
        )
      })}
    </div>
  )
}

function FactRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-outline-variant last:border-0">
      <div className="w-9 h-9 rounded-full bg-primary-container/10 flex items-center justify-center text-primary shrink-0">
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-label-sm text-on-surface-variant uppercase tracking-wide">{label}</p>
        <p className="text-label-md text-on-surface font-medium truncate">{value}</p>
      </div>
    </div>
  )
}

export default function CaseHub({
  auraId,
  showTrustedContacts = true,
  readOnly = false,
  showCounsellorLookup = true,
}: {
  auraId: string
  /** fetchMyCounsellor() and fetchTrustedContacts() both return the CALLER's
   * own data, not auraId's - correct when a victim views their own case, but
   * wrong if a counsellor/admin/guardian reuses this component for someone
   * else's case. Both default on for the victim's own usage and are turned
   * off wherever CaseHub is embedded for a non-owner viewer. */
  showTrustedContacts?: boolean
  showCounsellorLookup?: boolean
  /** Hides the "add a note" composer - for viewers (e.g. a guardian) who may
   * read this case but shouldn't be adding case updates to it. */
  readOnly?: boolean
}) {
  const [tab, setTab] = useState<Tab>("overview")
  const [profile, setProfile] = useState<CaseTypeRecord | null>(null)
  const [options, setOptions] = useState<CaseStageOptions | null>(null)
  const [updates, setUpdates] = useState<CaseUpdateRecord[] | null>(null)
  const [counsellors, setCounsellors] = useState<MyCounsellorRecord[] | null>(null)
  const [contacts, setContacts] = useState<TrustedContact[] | null>(null)
  const [history, setHistory] = useState<InterventionRecord[] | null>(null)
  const [draftTitle, setDraftTitle] = useState("")
  const [draftBody, setDraftBody] = useState("")
  const [posting, setPosting] = useState(false)

  useEffect(() => {
    fetchCaseType(auraId).then(setProfile)
    fetchCaseStageOptions().then(setOptions)
    fetchCaseUpdates(auraId).then((r) => setUpdates(r?.updates ?? []))
    if (showCounsellorLookup) fetchMyCounsellor().then((r) => setCounsellors(r?.counsellors ?? []))
    if (showTrustedContacts) fetchTrustedContacts().then((r) => setContacts(r?.contacts ?? []))
    fetchSupportHistory(auraId).then((r) => setHistory(r?.interventions ?? []))
  }, [auraId, showTrustedContacts, showCounsellorLookup])

  const reloadUpdates = () => fetchCaseUpdates(auraId).then((r) => setUpdates(r?.updates ?? []))

  const postUpdate = async () => {
    if (!draftTitle.trim()) return
    setPosting(true)
    const res = await createCaseUpdate(auraId, { category: "general", title: draftTitle.trim(), body: draftBody.trim() || undefined })
    setPosting(false)
    if (res.success) {
      setDraftTitle("")
      setDraftBody("")
      reloadUpdates()
    }
  }

  const stageLabel = (v: string) => options?.stages.find((s) => s.value === v)?.label ?? v
  const protectionLabel = (v: string) => options?.protection_statuses.find((s) => s.value === v)?.label ?? v
  const compensationLabel = (v: string) => options?.compensation_statuses.find((s) => s.value === v)?.label ?? v
  const rehabilitationLabel = (v: string) => options?.rehabilitation_statuses.find((s) => s.value === v)?.label ?? v

  return (
    <div className="flex flex-col gap-stack-md">
      <header>
        <div className="flex items-center gap-2 text-label-sm text-on-surface-variant uppercase tracking-wide mb-1">
          <FolderLock size={14} /> Case ID {auraId}
        </div>
        <h1 className="text-headline-lg text-on-surface">My Case</h1>
        <p className="text-body-md text-on-surface-variant mt-1">
          The complete record of your case — status, people involved, documents and support, all in one place.
        </p>
      </header>

      <div className="flex gap-1 overflow-x-auto border-b border-outline-variant">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`shrink-0 px-4 py-2.5 text-label-md font-semibold border-b-2 -mb-px transition-colors ${
              tab === t.key ? "border-primary text-primary" : "border-transparent text-on-surface-variant hover:text-on-surface"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="rounded-[24px] bg-surface-container-lowest border border-outline-variant p-stack-md card-shadow">
        {tab === "overview" && (
          <div className="flex flex-col gap-stack-md">
            <div>
              <p className="text-label-md font-semibold text-on-surface mb-3">Case journey</p>
              <StageJourney stage={profile?.stage ?? "complaint"} />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8">
              <FactRow icon={<Scale size={16} />} label="Current stage" value={profile ? stageLabel(profile.stage) : "—"} />
              <FactRow
                icon={<Phone size={16} />}
                label="Assigned officer"
                value={profile?.assigned_officer_name ? `${profile.assigned_officer_name}${profile.assigned_officer_contact ? ` · ${profile.assigned_officer_contact}` : ""}` : "Not yet assigned"}
              />
              <FactRow icon={<ShieldCheck size={16} />} label="Protection status" value={profile ? protectionLabel(profile.protection_status) : "—"} />
              <FactRow icon={<Landmark size={16} />} label="Compensation status" value={profile ? compensationLabel(profile.compensation_status) : "—"} />
              <FactRow icon={<HeartHandshake size={16} />} label="Rehabilitation status" value={profile ? rehabilitationLabel(profile.rehabilitation_status) : "—"} />
              {showCounsellorLookup && (
                <FactRow
                  icon={<UsersIcon size={16} />}
                  label="Counsellor"
                  value={counsellors && counsellors.length > 0 ? counsellors.map((c) => c.display_name).join(", ") : "Not yet assigned"}
                />
              )}
            </div>
          </div>
        )}

        {tab === "timeline" && (
          <UpdatesFeed updates={updates} emptyText="No case activity recorded yet." />
        )}

        {tab === "sessions" && <HistoryPage compact auraId={auraId} canClear={false} />}

        {tab === "documents" && <CaseDocuments auraId={auraId} />}

        {tab === "people" && (
          <div className="flex flex-col gap-stack-sm">
            <p className="text-label-md font-semibold text-on-surface">Officer</p>
            <p className="text-label-md text-on-surface-variant mb-2">
              {profile?.assigned_officer_name
                ? `${profile.assigned_officer_name}${profile.assigned_officer_contact ? ` — ${profile.assigned_officer_contact}` : ""}`
                : "No officer assigned yet."}
            </p>
            {showCounsellorLookup && (
              <>
                <p className="text-label-md font-semibold text-on-surface">Counsellor</p>
                {counsellors === null ? (
                  <p className="text-label-sm text-on-surface-variant">Loading…</p>
                ) : counsellors.length === 0 ? (
                  <p className="text-label-md text-on-surface-variant mb-2">No counsellor assigned yet.</p>
                ) : (
                  counsellors.map((c) => (
                    <p key={c.user_id} className="text-label-md text-on-surface-variant mb-2">
                      {c.display_name}
                      {c.title ? ` — ${c.title}` : ""}
                      {c.focus_area ? ` (${c.focus_area})` : ""}
                    </p>
                  ))
                )}
              </>
            )}
            {showTrustedContacts && (
              <>
                <p className="text-label-md font-semibold text-on-surface mt-2">Your trusted contacts</p>
                {contacts === null ? (
                  <p className="text-label-sm text-on-surface-variant">Loading…</p>
                ) : contacts.length === 0 ? (
                  <p className="text-label-md text-on-surface-variant">
                    You haven't added anyone yet — add trusted contacts from Safety Plan.
                  </p>
                ) : (
                  contacts.map((c) => (
                    <p key={c.id} className="text-label-md text-on-surface-variant">
                      {c.name}
                      {c.relationship_label ? ` (${c.relationship_label})` : ""}
                      {c.phone ? ` — ${c.phone}` : ""}
                    </p>
                  ))
                )}
              </>
            )}
          </div>
        )}

        {tab === "updates" && (
          <div className="flex flex-col gap-stack-sm">
            {!readOnly && (
              <div className="rounded-2xl border border-outline-variant p-4">
                <p className="text-label-md font-semibold text-on-surface mb-2">Add a note to this case</p>
                <input
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  placeholder="What's this about?"
                  className="w-full rounded-lg border border-outline-variant px-3 py-2 text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-primary"
                />
                <textarea
                  value={draftBody}
                  onChange={(e) => setDraftBody(e.target.value)}
                  placeholder="Details (optional)"
                  rows={2}
                  className="w-full rounded-lg border border-outline-variant px-3 py-2 text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-primary"
                />
                <button
                  onClick={postUpdate}
                  disabled={posting || !draftTitle.trim()}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary text-on-primary text-label-sm font-semibold disabled:opacity-50"
                >
                  <Plus size={14} /> {posting ? "Adding…" : "Add note"}
                </button>
              </div>
            )}
            <UpdatesFeed updates={updates} emptyText="No updates yet." />
          </div>
        )}

        {tab === "support" && (
          <div className="flex flex-col gap-stack-sm">
            {history === null ? (
              <p className="text-label-sm text-on-surface-variant">Loading…</p>
            ) : history.length === 0 ? (
              <p className="text-label-md text-on-surface-variant">No support pathways recorded yet.</p>
            ) : (
              <div className="flex flex-col divide-y divide-outline-variant">
                {history.map((h) => {
                  const status = STATUS_COPY[h.status] ?? { label: h.status, tone: "text-on-surface-variant" }
                  return (
                    <div key={h.id} className="py-2.5">
                      <p className="text-label-md font-medium text-on-surface">{h.pathway}</p>
                      <p className={`text-label-sm ${status.tone}`}>{status.label}</p>
                    </div>
                  )
                })}
              </div>
            )}
            <a href="#support" className="inline-flex items-center gap-1.5 text-label-md text-primary font-semibold mt-2">
              <ExternalLink size={14} /> Open full Support Centre
            </a>
          </div>
        )}
      </div>
    </div>
  )
}

function UpdatesFeed({ updates, emptyText }: { updates: CaseUpdateRecord[] | null; emptyText: string }) {
  if (updates === null) return <p className="text-label-sm text-on-surface-variant">Loading…</p>
  if (updates.length === 0) return <p className="text-label-md text-on-surface-variant">{emptyText}</p>
  return (
    <div className="flex flex-col divide-y divide-outline-variant">
      {updates.map((u) => (
        <div key={u.id} className="py-3">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-label-sm px-2 py-0.5 rounded-full bg-primary-container/10 text-primary font-semibold">
              {CATEGORY_LABEL[u.category] ?? u.category}
            </span>
            <span className="text-label-sm text-on-surface-variant">
              {new Date(u.created_at).toLocaleString()} · {u.author_role}
            </span>
          </div>
          <p className="text-label-md font-medium text-on-surface">{u.title}</p>
          {u.body && <p className="text-label-sm text-on-surface-variant mt-0.5">{u.body}</p>}
        </div>
      ))}
    </div>
  )
}
