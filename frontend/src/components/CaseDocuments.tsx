import { useEffect, useRef, useState } from "react"
import { Paperclip, Download, Trash2, Upload } from "lucide-react"
import {
  CaseDocumentRecord,
  deleteCaseDocument,
  downloadCaseDocument,
  fetchCaseDocuments,
  uploadCaseDocument,
} from "../lib/auraApi"
import { fetchMe, AuthUser } from "../lib/authApi"

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Case-document tracking: attach and review files kept against a case (FIR
 * copy, medical report, ID proof). Shared between the victim's own Support
 * page and the counsellor's Care Plan tab - same records, same endpoints,
 * so nothing gets out of sync between what each side sees.
 */
export default function CaseDocuments({ auraId }: { auraId: string }) {
  const [docs, setDocs] = useState<CaseDocumentRecord[] | null>(null)
  const [me, setMe] = useState<AuthUser | null>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const load = () => {
    fetchCaseDocuments(auraId).then((r) => setDocs(r?.documents ?? []))
  }

  useEffect(() => {
    fetchMe().then(setMe)
  }, [])

  useEffect(() => {
    setDocs(null)
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auraId])

  const onPick = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    setUploading(true)
    const res = await uploadCaseDocument(auraId, file)
    setUploading(false)
    if (!res.success) {
      setError(res.error ?? "Could not upload the document.")
      return
    }
    load()
  }

  const onDelete = async (id: string) => {
    await deleteCaseDocument(auraId, id)
    load()
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-label-sm text-on-surface-variant">
          FIR copies, medical reports, ID proof — kept with this case for anyone authorised to review it.
        </p>
        <button
          onClick={() => fileInput.current?.click()}
          disabled={uploading}
          className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary text-on-primary text-label-sm font-semibold disabled:opacity-50"
        >
          <Upload size={14} /> {uploading ? "Uploading…" : "Add document"}
        </button>
        <input
          ref={fileInput}
          type="file"
          className="hidden"
          accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx"
          onChange={(e) => onPick(e.target.files?.[0])}
        />
      </div>

      {error && <p className="text-label-sm text-error mb-2">{error}</p>}

      {docs === null ? (
        <p className="text-label-sm text-on-surface-variant">Loading…</p>
      ) : docs.length === 0 ? (
        <p className="text-label-sm text-on-surface-variant">No documents attached yet.</p>
      ) : (
        <div className="flex flex-col divide-y divide-outline-variant">
          {docs.map((d) => (
            <div key={d.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="flex items-center gap-2.5 min-w-0">
                <Paperclip size={15} className="text-on-surface-variant shrink-0" />
                <div className="min-w-0">
                  <p className="text-label-md text-on-surface truncate">{d.name}</p>
                  <p className="text-label-sm text-on-surface-variant">
                    {formatSize(d.size_bytes)} · {new Date(d.created_at).toLocaleDateString()} · {d.uploaded_by_role}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => downloadCaseDocument(auraId, d.id, d.name)}
                  className="p-2 rounded-full hover:bg-surface-container-low text-on-surface-variant"
                  title="Download"
                >
                  <Download size={15} />
                </button>
                {me && (me.role === "admin" || d.uploaded_by_role === me.role) && (
                  <button
                    onClick={() => onDelete(d.id)}
                    className="p-2 rounded-full hover:bg-error-container/20 text-error"
                    title="Remove"
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
