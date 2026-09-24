export type AvatarType = "fox" | "dog" | "cat" | "rabbit" | "plant" | "robot" | "orb" | "custom"

export type Expression =
  | "natural"
  | "happy"
  | "sad"
  | "concerned"
  | "angry"
  | "surprised"
  | "calm"
  | "neutral"

/** "auto" follows the animationState prop driven by the surrounding
 * conversation (recording/sending/speaking); any other value is a manual
 * override picked from the Animation dropdown. */
export type AnimationSelection = "auto" | AvatarAnimationState

export type AvatarAnimationState = "idle" | "talking" | "listening" | "thinking" | "greeting" | "concerned"

export interface AvatarRenderProps {
  expression: Expression
  animation: AvatarAnimationState
  amplitude: number
  lipSyncEnabled: boolean
  onError?: () => void
}
