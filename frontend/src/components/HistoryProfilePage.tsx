import { useState } from "react"
import HistoryPage from "./HistoryPage"
import ProfilePage from "./ProfilePage"
import { VoiceCapabilities } from "../types"

type SubPage = "history" | "profile"

/**
 * Combines History and Profile under one nav entry. Neither page's own
 * internals change - this is only the outer switcher; HistoryPage and
 * ProfilePage are rendered exactly as before.
 */
export default function HistoryProfilePage({
  capabilities,
  backendOnline,
}: {
  capabilities: VoiceCapabilities | null
  backendOnline: boolean | null
}) {
  const [sub, setSub] = useState<SubPage>("history")

  return (
    <div className="space-y-stack-sm">
      <div className="flex gap-1 border-b border-outline-variant">
        {(
          [
            ["history", "History"],
            ["profile", "Profile"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setSub(key)}
            className={`px-4 py-2 text-label-md whitespace-nowrap -mb-px border-b-2 ${
              sub === key
                ? "border-primary text-primary font-bold"
                : "border-transparent text-on-surface-variant hover:text-on-surface"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {sub === "history" ? (
        <HistoryPage />
      ) : (
        <ProfilePage capabilities={capabilities} backendOnline={backendOnline} />
      )}
    </div>
  )
}
