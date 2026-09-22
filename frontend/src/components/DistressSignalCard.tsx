import { ArrowUp, ArrowDown, Minus, Info } from "lucide-react"
import { DistressSignalResponse } from "../types"

const LEVEL_STYLE: Record<string, { bar: string; text: string; chip: string; label: string }> = {
  GREEN: {
    bar: "bg-secondary",
    text: "text-on-secondary-container",
    chip: "bg-secondary-container/20 border-secondary/20 text-on-secondary-container",
    label: "GREEN",
  },
  AMBER: {
    bar: "bg-amber-500",
    text: "text-amber-700",
    chip: "bg-amber-50 border-amber-200 text-amber-700",
    label: "AMBER",
  },
  RED: {
    bar: "bg-error",
    text: "text-error",
    chip: "bg-error-container/20 border-error/40 text-error",
    label: "RED",
  },
}

function DirectionIcon({ direction }: { direction: string }) {
  if (direction === "up") return <ArrowUp size={12} className="text-amber-600" />
  if (direction === "down") return <ArrowDown size={12} className="text-tertiary" />
  return <Minus size={12} className="text-on-surface-variant/60" />
}

export default function DistressSignalCard({
  signal,
}: {
  signal: DistressSignalResponse | null
}) {
  const style = LEVEL_STYLE[signal?.level ?? "GREEN"] ?? LEVEL_STYLE.GREEN

  return (
    <section className="rounded-xl bg-surface-container-lowest border border-outline-variant p-5">
      <div className="flex items-start justify-between mb-3">
        <div>
          <h2 className="text-sm font-semibold text-on-surface">Dynamic Distress Signal</h2>
          <p className="text-[11px] text-on-surface-variant">Decision-support indicator</p>
        </div>
        {signal && !signal.insufficient_data && (
          <span
            className={`px-2.5 py-1 rounded-full border text-[11px] font-bold tracking-wide ${style.chip}`}
          >
            {style.label}
          </span>
        )}
      </div>

      {!signal || signal.insufficient_data ? (
        <p className="text-xs text-on-surface-variant">
          {signal?.factors?.[0]?.detail
            ? `Collecting observations — ${signal.factors[0].detail}.`
            : "Start an analysis to build the signal."}
        </p>
      ) : (
        <>
          <div className="flex items-end gap-2 mb-2">
            <span className={`text-4xl font-bold tabular-nums ${style.text}`}>
              {signal.score.toFixed(0)}
            </span>
            <span className="text-sm text-on-surface-variant/70 mb-1.5">/ 100</span>
            <span className="ml-auto text-[11px] text-on-surface-variant mb-1.5">
              Signal confidence{" "}
              <span className="font-semibold text-on-surface-variant">
                {signal.confidence.toFixed(0)}%
              </span>
            </span>
          </div>

          <div
            className="h-2 rounded-full bg-surface-container-high overflow-hidden mb-4"
            role="meter"
            aria-valuenow={Math.round(signal.score)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Distress signal"
          >
            <div
              className={`h-full ${style.bar} transition-[width] duration-500`}
              style={{ width: `${Math.min(100, signal.score)}%` }}
            />
          </div>

          <div className="mb-3">
            <h3 className="text-[10px] uppercase tracking-wide text-on-surface-variant mb-1.5">
              Contributing factors
            </h3>
            <ul className="space-y-1">
              {signal.factors.map((factor, i) => (
                <li key={i} className="flex items-start gap-1.5 text-[11px]">
                  <span className="mt-0.5">
                    <DirectionIcon direction={factor.direction} />
                  </span>
                  <span className="text-on-surface-variant">{factor.label}</span>
                  <span className="text-on-surface-variant/70">— {factor.detail}</span>
                </li>
              ))}
            </ul>
          </div>

          {signal.themes && signal.themes.length > 0 && (
            <div className="mb-3">
              <h3 className="text-[10px] uppercase tracking-wide text-on-surface-variant mb-1.5">
                Detected emotional themes
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {signal.themes.map((t) => (
                  <span
                    key={t.theme}
                    title={`matched: ${t.matches.join(", ")}`}
                    className="px-2 py-0.5 rounded-full bg-surface-container-high border border-outline-variant text-[11px] text-on-surface-variant"
                  >
                    {t.theme}
                    <span className="text-on-surface-variant/70"> ·{t.count}</span>
                  </span>
                ))}
              </div>
              <p className="text-[10px] text-on-surface-variant/70 mt-1">
                Themes are words present in the transcript, not inferences about the speaker.
              </p>
            </div>
          )}
        </>
      )}

      <p className="flex items-start gap-1.5 text-[10px] text-on-surface-variant pt-3 border-t border-outline-variant">
        <Info size={11} className="mt-0.5 shrink-0" />
        {signal?.disclaimer ??
          "Prototype decision-support signal — not a clinical diagnosis."}
      </p>
    </section>
  )
}
