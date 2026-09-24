/**
 * Ambient decorative background for cinematic surfaces: a few large, blurred,
 * slowly-drifting gradient blobs plus a faint grain overlay. Purely visual -
 * absolutely positioned, pointer-events disabled, never affects layout.
 */
export default function GlowField() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
      <div className="absolute -top-40 -left-32 w-[560px] h-[560px] rounded-full aura-glow-violet blur-3xl opacity-60 animate-aura-drift" />
      <div
        className="absolute top-1/3 -right-40 w-[520px] h-[520px] rounded-full aura-glow-amber blur-3xl opacity-40 animate-aura-drift"
        style={{ animationDelay: "-6s" }}
      />
      <div
        className="absolute bottom-0 left-1/4 w-[480px] h-[480px] rounded-full aura-glow-teal blur-3xl opacity-30 animate-aura-drift"
        style={{ animationDelay: "-11s" }}
      />
      <div className="aura-grain" />
    </div>
  )
}
