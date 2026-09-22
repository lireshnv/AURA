import { useCallback, useEffect, useState } from "react"
import { Users, ShieldCheck, Server, ScrollText, UserPlus, Link2, Loader2 } from "lucide-react"
import {
  AdminUser,
  Assignment,
  GuardianLink,
  Role,
  adminCreateAssignment,
  adminCreateGuardianLink,
  adminCreateUser,
  adminListAssignments,
  adminListGuardianLinks,
  adminListUsers,
  adminRevokeAssignment,
  adminRevokeGuardianLink,
  adminUpdateUser,
} from "../lib/authApi"
import { seedDemoData } from "../lib/auraApi"
import { fetchAuditLog, AuditEntryRow } from "../lib/riskApi"
import { API_BASE_URL } from "../lib/api"

const STAFF_ROLES: { value: Role; label: string }[] = [
  { value: "counsellor", label: "Counsellor" },
  { value: "admin", label: "Administrator" },
  { value: "guardian", label: "Guardian" },
]

function Card({ title, icon: Icon, children }: { title: string; icon: typeof Users; children: React.ReactNode }) {
  return (
    <section className="rounded-[24px] bg-surface-container-lowest border border-outline-variant p-stack-md card-shadow">
      <h2 className="text-headline-md text-on-surface flex items-center gap-2 mb-4">
        <Icon size={18} className="text-primary" />
        {title}
      </h2>
      {children}
    </section>
  )
}

export default function AdminDashboard() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [auditEntries, setAuditEntries] = useState<AuditEntryRow[]>([])
  const [systemStatus, setSystemStatus] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)

  const [newEmail, setNewEmail] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [newName, setNewName] = useState("")
  const [newRole, setNewRole] = useState<Role>("counsellor")
  const [creating, setCreating] = useState(false)
  const [createMessage, setCreateMessage] = useState<string | null>(null)

  const [assignCounsellor, setAssignCounsellor] = useState("")
  const [assignVictimAuraId, setAssignVictimAuraId] = useState("")
  const [assigning, setAssigning] = useState(false)

  const [guardianLinks, setGuardianLinks] = useState<GuardianLink[]>([])
  const [linkGuardian, setLinkGuardian] = useState("")
  const [linkVictimAuraId, setLinkVictimAuraId] = useState("")
  const [linking, setLinking] = useState(false)

  const [seeding, setSeeding] = useState(false)
  const [seedMessage, setSeedMessage] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const [u, a, g, audit] = await Promise.all([
      adminListUsers(),
      adminListAssignments(),
      adminListGuardianLinks(),
      fetchAuditLog(50),
    ])
    setUsers(u)
    setAssignments(a)
    setGuardianLinks(g)
    setAuditEntries(audit?.entries ?? [])
    setLoading(false)
  }, [])

  useEffect(() => {
    reload()
    fetch(`${API_BASE_URL}/api/system/status`)
      .then((r) => r.json())
      .then(setSystemStatus)
      .catch(() => setSystemStatus(null))
  }, [reload])

  const createStaff = async () => {
    setCreateMessage(null)
    if (!newEmail.trim() || newPassword.length < 12) {
      setCreateMessage("Enter an email and a password of at least 12 characters.")
      return
    }
    setCreating(true)
    const res = await adminCreateUser(newEmail.trim(), newPassword, newRole as "counsellor" | "admin" | "guardian", newName.trim() || undefined)
    setCreating(false)
    if (res.success) {
      setCreateMessage(`${STAFF_ROLES.find((r) => r.value === newRole)?.label} account created.`)
      setNewEmail("")
      setNewPassword("")
      setNewName("")
      reload()
    } else {
      setCreateMessage(res.error ?? "Could not create the account.")
    }
  }

  const toggleActive = async (user: AdminUser) => {
    await adminUpdateUser(user.id, { is_active: !user.is_active })
    reload()
  }

  const assignVictim = async () => {
    if (!assignCounsellor || !assignVictimAuraId.trim()) return
    setAssigning(true)
    await adminCreateAssignment(assignCounsellor, assignVictimAuraId.trim())
    setAssigning(false)
    setAssignVictimAuraId("")
    reload()
  }

  const revoke = async (id: string) => {
    await adminRevokeAssignment(id)
    reload()
  }

  const linkVictim = async () => {
    if (!linkGuardian || !linkVictimAuraId.trim()) return
    setLinking(true)
    await adminCreateGuardianLink(linkGuardian, linkVictimAuraId.trim())
    setLinking(false)
    setLinkVictimAuraId("")
    reload()
  }

  const revokeLink = async (id: string) => {
    await adminRevokeGuardianLink(id)
    reload()
  }

  const runSeedDemoData = async () => {
    setSeeding(true)
    setSeedMessage(null)
    const res = await seedDemoData()
    setSeeding(false)
    setSeedMessage(res.success ? res.note ?? "Demo data seeded." : res.error ?? "Could not seed demo data.")
  }

  const counsellors = users.filter((u) => u.role === "counsellor")
  const guardians = users.filter((u) => u.role === "guardian")

  if (loading) {
    return <p className="text-body-md text-on-surface-variant">Loading admin dashboard…</p>
  }

  return (
    <div className="space-y-stack-sm">
      <div>
        <h1 className="text-display-lg-mobile text-on-surface">Admin Dashboard</h1>
        <p className="text-body-lg text-on-surface-variant mt-1">
          Accounts, authorization and system health.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-gutter">
        <Card title="User Management" icon={Users}>
          <div className="max-h-64 overflow-y-auto space-y-1.5 mb-4">
            {users.length === 0 ? (
              <p className="text-label-md text-on-surface-variant">No users yet.</p>
            ) : (
              users.map((u) => (
                <div key={u.id} className="flex items-center justify-between gap-2 py-2 border-b border-surface-container-high last:border-0">
                  <div className="min-w-0">
                    <p className="text-label-md text-on-surface truncate">{u.email}</p>
                    <p className="text-label-sm text-on-surface-variant capitalize">
                      {u.role.replace("_", " ")} · {u.is_active ? "Active" : "Deactivated"}
                    </p>
                  </div>
                  <button
                    onClick={() => toggleActive(u)}
                    className={`shrink-0 px-2.5 py-1 rounded-full text-label-sm border ${
                      u.is_active
                        ? "border-error/30 text-error"
                        : "border-secondary/30 text-secondary"
                    }`}
                  >
                    {u.is_active ? "Deactivate" : "Activate"}
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="pt-3 border-t border-outline-variant">
            <h3 className="text-label-md font-semibold text-on-surface mb-2 flex items-center gap-1.5">
              <UserPlus size={14} />
              Create staff account
            </h3>
            <div className="grid grid-cols-2 gap-2 mb-2">
              <input
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder="Email"
                className="col-span-2 rounded-lg border border-outline-variant px-3 py-2 text-sm"
              />
              <input
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                type="password"
                placeholder="Password (12+ chars)"
                className="col-span-2 rounded-lg border border-outline-variant px-3 py-2 text-sm"
              />
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Display name (optional)"
                className="rounded-lg border border-outline-variant px-3 py-2 text-sm"
              />
              <select
                value={newRole}
                onChange={(e) => setNewRole(e.target.value as Role)}
                className="rounded-lg border border-outline-variant px-3 py-2 text-sm bg-surface-container-lowest"
              >
                {STAFF_ROLES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            {createMessage && <p className="text-label-sm text-primary mb-2">{createMessage}</p>}
            <button
              onClick={createStaff}
              disabled={creating}
              className="w-full py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {creating && <Loader2 size={14} className="animate-spin" />}
              Create account
            </button>
          </div>
        </Card>

        <Card title="Counsellor Authorization" icon={Link2}>
          <p className="text-label-sm text-on-surface-variant mb-3">
            Only assigned victims appear in a counsellor's case queue.
          </p>
          <div className="flex flex-col gap-2 mb-3">
            <select
              value={assignCounsellor}
              onChange={(e) => setAssignCounsellor(e.target.value)}
              className="rounded-lg border border-outline-variant px-3 py-2 text-sm bg-surface-container-lowest"
            >
              <option value="">Select a counsellor…</option>
              {counsellors.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.email}
                </option>
              ))}
            </select>
            <input
              value={assignVictimAuraId}
              onChange={(e) => setAssignVictimAuraId(e.target.value)}
              placeholder="Victim AURA-ID (e.g. AURA-XXXXXXXXXXXX)"
              className="rounded-lg border border-outline-variant px-3 py-2 text-sm"
            />
            <button
              onClick={assignVictim}
              disabled={assigning || !assignCounsellor || !assignVictimAuraId.trim()}
              className="py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold disabled:opacity-50"
            >
              Authorize access
            </button>
          </div>
          <div className="max-h-40 overflow-y-auto space-y-1.5">
            {assignments.length === 0 ? (
              <p className="text-label-md text-on-surface-variant">No assignments yet.</p>
            ) : (
              assignments.map((a) => {
                const counsellor = users.find((u) => u.id === a.counsellor_user_id)
                return (
                  <div key={a.id} className="flex items-center justify-between text-label-sm py-1.5 border-b border-surface-container-high last:border-0">
                    <span className="text-on-surface-variant truncate">
                      {counsellor?.email ?? a.counsellor_user_id} → {a.victim_aura_id}
                    </span>
                    {a.active && (
                      <button onClick={() => revoke(a.id)} className="text-error shrink-0 ml-2">
                        Revoke
                      </button>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </Card>

        <Card title="Guardian Authorization" icon={Link2}>
          <p className="text-label-sm text-on-surface-variant mb-3">
            A guardian sees only their linked victim's well-being summary - no transcripts or facial data.
          </p>
          <div className="flex flex-col gap-2 mb-3">
            <select
              value={linkGuardian}
              onChange={(e) => setLinkGuardian(e.target.value)}
              className="rounded-lg border border-outline-variant px-3 py-2 text-sm bg-surface-container-lowest"
            >
              <option value="">Select a guardian…</option>
              {guardians.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.email}
                </option>
              ))}
            </select>
            <input
              value={linkVictimAuraId}
              onChange={(e) => setLinkVictimAuraId(e.target.value)}
              placeholder="Victim AURA-ID (e.g. AURA-XXXXXXXXXXXX)"
              className="rounded-lg border border-outline-variant px-3 py-2 text-sm"
            />
            <button
              onClick={linkVictim}
              disabled={linking || !linkGuardian || !linkVictimAuraId.trim()}
              className="py-2 rounded-full bg-primary text-on-primary text-label-md font-semibold disabled:opacity-50"
            >
              Authorize access
            </button>
          </div>
          <div className="max-h-40 overflow-y-auto space-y-1.5">
            {guardianLinks.length === 0 ? (
              <p className="text-label-md text-on-surface-variant">No guardian links yet.</p>
            ) : (
              guardianLinks.map((l) => {
                const guardian = users.find((u) => u.id === l.guardian_user_id)
                return (
                  <div key={l.id} className="flex items-center justify-between text-label-sm py-1.5 border-b border-surface-container-high last:border-0">
                    <span className="text-on-surface-variant truncate">
                      {guardian?.email ?? l.guardian_user_id} → {l.victim_aura_id}
                    </span>
                    {l.active && (
                      <button onClick={() => revokeLink(l.id)} className="text-error shrink-0 ml-2">
                        Revoke
                      </button>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </Card>

        <Card title="System Status" icon={Server}>
          {systemStatus ? (
            <div className="space-y-1.5 text-label-md">
              <div className="flex justify-between">
                <span className="text-on-surface-variant">Environment</span>
                <span className="text-on-surface">{String(systemStatus.environment ?? "—")}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-on-surface-variant">Database</span>
                <span className="text-on-surface">{String(systemStatus.database_backend ?? "—")}</span>
              </div>
              {systemStatus.integrations != null &&
                Object.entries(systemStatus.integrations as Record<string, { configured: boolean }>).map(
                  ([name, info]) => (
                    <div key={name} className="flex justify-between">
                      <span className="text-on-surface-variant capitalize">{name}</span>
                      <span className={info.configured ? "text-secondary" : "text-on-surface-variant"}>
                        {info.configured ? "Configured" : "Not configured"}
                      </span>
                    </div>
                  )
                )}
            </div>
          ) : (
            <p className="text-label-md text-on-surface-variant">System status unavailable.</p>
          )}

          <div className="pt-3 mt-3 border-t border-outline-variant">
            <h3 className="text-label-md font-semibold text-on-surface mb-1.5">Demo data</h3>
            <p className="text-label-sm text-on-surface-variant mb-2">
              Writes a small synthetic well-being history through the real storage path, so the
              victim dashboard, an assigned counsellor's case queue, a linked guardian's summary
              and this admin's case list all show the same connected numbers. Non-production only.
            </p>
            <button
              onClick={runSeedDemoData}
              disabled={seeding}
              className="px-3 py-1.5 rounded-full border border-outline-variant text-label-sm text-on-surface hover:bg-surface-container-low disabled:opacity-50 flex items-center gap-2"
            >
              {seeding && <Loader2 size={13} className="animate-spin" />}
              Seed synthetic demo data
            </button>
            {seedMessage && <p className="text-label-sm text-primary mt-2">{seedMessage}</p>}
          </div>
        </Card>

        <Card title="Audit Activity" icon={ScrollText}>
          <div className="max-h-64 overflow-y-auto space-y-1.5">
            {auditEntries.length === 0 ? (
              <p className="text-label-md text-on-surface-variant">No audit activity yet.</p>
            ) : (
              auditEntries.map((e) => (
                <div key={e.id} className="text-label-sm py-1.5 border-b border-surface-container-high last:border-0">
                  <p className="text-on-surface">
                    <span className="font-medium capitalize">{e.action.replace(/_/g, " ")}</span>{" "}
                    <span className="text-on-surface-variant">by {e.actor_role}</span>
                  </p>
                  <p className="text-on-surface-variant/70">{new Date(e.timestamp).toLocaleString()}</p>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      <div className="rounded-[24px] bg-surface-container-low border border-outline-variant p-4 flex items-start gap-2">
        <ShieldCheck size={16} className="text-on-surface-variant mt-0.5 shrink-0" />
        <p className="text-label-sm text-on-surface-variant">
          Every account creation, role change and authorization change here is written to the
          append-only audit log above.
        </p>
      </div>
    </div>
  )
}
