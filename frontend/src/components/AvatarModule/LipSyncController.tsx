/** Enable/disable toggle for real-time mouth movement. The actual amplitude
 * sampling lives in useAudioAmplitude (driven by the real TTS <audio>
 * element) - this component is just the on/off control surface. */
export default function LipSyncController({
  enabled,
  onChange,
}: {
  enabled: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-label-md text-on-surface-variant cursor-pointer">
      <span className="flex items-center gap-1.5">
        <span className="material-symbols-outlined text-[16px]">graphic_eq</span>
        Voice / Lip Sync
      </span>
      <input
        type="checkbox"
        checked={enabled}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-primary w-4 h-4"
      />
    </label>
  )
}
