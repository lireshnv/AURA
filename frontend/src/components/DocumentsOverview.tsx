import { useMemo, useState } from "react"
import { FileText, Download } from "lucide-react"
import { CaseDocumentOverviewRecord, downloadCaseDocument } from "../lib/auraApi"

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * The cross-case Documents view shared by Counsellor and Admin - every
 * tracked case document across every authorised case, backed by
 * GET /api/aura/case-documents-overview. Search/filter only; uploading
 * still happens from the owning case's own Case Hub (CaseDocuments), so
 * there's one real place a document enters the system, not two.
 */
export default function DocumentsOverview({
  documents,
  onOpenCase,
}: {
  documents: CaseDocumentOverviewRecord[] | null
  onOpenCase?: (auraId: string) => void
}) {
  const [query, setQuery] = useState("")

  const filtered = useMemo(() => {
    if (!documents) return null
    const q = query.trim().toLowerCase()
    if (!q) return documents
    return documents.filter(
      (d) =>
        d.aura_id.toLowerCase().includes(q) ||
        d.name.toLowerCase().includes(q) ||
        (d.label ?? "").toLowerCase().includes(q)
    )
  }, [documents, query])

  return (
    <div className="flex flex-col gap-stack-sm">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by case, file name or label…"
        className="rounded-lg border border-outline-variant px-3 py-2 text-sm bg-surface-container-lowest w-full max-w-md"
      />

      {filtered === null ? (
        <p className="text-label-sm text-on-surface-variant">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="text-label-md text-on-surface-variant/60 py-6 text-center">
          {documents && documents.length > 0 ? "No documents match your search." : "No documents uploaded across your cases yet."}
        </p>
      ) : (
        <div className="flex flex-col divide-y divide-outline-variant rounded-[24px] bg-surface-container-lowest border border-outline-variant">
          {filtered.map((d) => (
            <div key={d.id} className="flex items-center gap-3 px-4 py-3">
              <div className="w-9 h-9 rounded-full bg-primary-container/10 flex items-center justify-center text-primary shrink-0">
                <FileText size={16} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-label-md font-medium text-on-surface truncate">{d.label || d.name}</p>
                  <button
                    onClick={() => onOpenCase?.(d.aura_id)}
                    disabled={!onOpenCase}
                    className="text-label-sm text-primary font-semibold shrink-0 hover:underline disabled:no-underline disabled:text-on-surface-variant"
                  >
                    {d.aura_id}
                  </button>
                </div>
                <p className="text-label-sm text-on-surface-variant">
                  {formatSize(d.size_bytes)} · {d.uploaded_by_role} · {new Date(d.created_at).toLocaleDateString()}
                </p>
              </div>
              <button
                onClick={() => downloadCaseDocument(d.aura_id, d.id, d.name)}
                className="shrink-0 p-2 rounded-full hover:bg-surface-container-low text-on-surface-variant hover:text-primary"
                title="Download"
              >
                <Download size={15} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
