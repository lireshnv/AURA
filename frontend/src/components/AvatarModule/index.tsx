import { useState } from "react"
import AvatarViewer from "./AvatarViewer"
import AvatarTypeDropdown from "./AvatarTypeDropdown"
import ExpressionSelector from "./ExpressionSelector"
import AnimationSelector from "./AnimationSelector"
import LipSyncController from "./LipSyncController"
import CustomizeButton from "./CustomizeButton"
import { useAvatarIdentity } from "./useAvatarIdentity"
import { AnimationSelection, AvatarAnimationState, Expression } from "./types"

/**
 * ONE unified companion module. Every avatar type (dog/cat/robot/plant/
 * custom) renders through the same AvatarViewer canvas - switching the
 * dropdown swaps the model, never the surrounding UI or component tree.
 * There is no generic human avatar - the companion is always a pet or a
 * plant, which is what Daily Care's feed/water/streak actions act on.
 *
 * `drivenAnimation`/`amplitude` let a host (Daily Care, after a real
 * completed action) puppet the avatar from real state; the Animation
 * dropdown's "Auto" option (the default) follows that, while picking a
 * specific animation overrides it until switched back to Auto.
 *
 * `compact` renders just the viewer (no dropdowns/Customize) for reuse in
 * smaller spots - identity (avatar type) is shared live via
 * useAvatarIdentity, so every instance on the page always shows the SAME
 * companion, never a duplicate one with its own separate type.
 */
export default function AvatarModule({
  drivenAnimation = "idle",
  amplitude = 0,
  className = "",
  compact = false,
}: {
  drivenAnimation?: AvatarAnimationState
  amplitude?: number
  className?: string
  compact?: boolean
}) {
  const { avatarType, setAvatarType } = useAvatarIdentity()
  const [expression, setExpression] = useState<Expression>("natural")
  const [animationSelection, setAnimationSelection] = useState<AnimationSelection>("auto")
  const [lipSyncEnabled, setLipSyncEnabled] = useState(true)
  // Uploaded files produce a blob: URL, only valid for this page session.
  const [customGlbUrl, setCustomGlbUrl] = useState<string | null>(null)

  const effectiveAnimation: AvatarAnimationState = animationSelection === "auto" ? drivenAnimation : animationSelection

  const viewer = (
    <AvatarViewer
      avatarType={avatarType}
      customGlbUrl={customGlbUrl}
      expression={expression}
      animation={effectiveAnimation}
      amplitude={amplitude}
      lipSyncEnabled={lipSyncEnabled}
      interactive={!compact}
    />
  )

  if (compact) {
    return <div className={`w-full h-full rounded-2xl overflow-hidden ${className}`}>{viewer}</div>
  }

  return (
    <section className={`bg-surface-container-lowest rounded-[24px] card-shadow p-stack-md flex flex-col gap-4 ${className}`}>
      <h2 className="text-headline-md text-on-surface flex items-center gap-2">
        <span className="material-symbols-outlined text-primary">
          {avatarType === "plant" ? "eco" : "pets"}
        </span>
        Companion
      </h2>

      <div className="w-full aspect-square max-h-[420px] mx-auto">{viewer}</div>

      <div className="flex flex-col gap-2.5 pt-1">
        <AvatarTypeDropdown value={avatarType} onChange={setAvatarType} />
        <ExpressionSelector value={expression} onChange={setExpression} />
        <AnimationSelector value={animationSelection} onChange={setAnimationSelection} />
        <LipSyncController enabled={lipSyncEnabled} onChange={setLipSyncEnabled} />
      </div>

      <CustomizeButton avatarType={avatarType} onCustomAvatarUploaded={setCustomGlbUrl} />
    </section>
  )
}
