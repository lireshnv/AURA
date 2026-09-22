import { useEffect, useMemo, useRef } from "react"
import { useAnimations, useGLTF } from "@react-three/drei"
import * as THREE from "three"
import { SkeletonUtils } from "three-stdlib"
import { AvatarRenderProps } from "../types"

const FOX_URL = "/models/Fox.glb"

// Box3.setFromObject() on this SkinnedMesh doesn't return a usable bounding
// box at runtime (it reads the raw un-skinned buffer, which for this rig
// isn't a simple standing pose), so these come straight from the glTF
// POSITION accessor's declared min/max instead (verified by inspecting the
// .glb's JSON chunk directly): X +-12.59 (width), Y -0.12..78.91 (height,
// feet near 0), Z -88.1..66.6 (nose-to-tail length - the model's long axis
// is Z, not X, which is why it needs a 90 degree turn below to face the
// camera broadside instead of nose/tail-on).
const FOX_SCALE = 2.7 / 78.91
const FOX_MIN_Y = -0.12
const FOX_CENTER_Z = -10.735
const GROUND_Y = -1.68
const FOX_OFFSET: [number, number, number] = [0, GROUND_Y - FOX_MIN_Y * FOX_SCALE, -FOX_CENTER_Z * FOX_SCALE]

/**
 * A real rigged, animated 3D character (not hand-built primitive geometry):
 * the free low-poly fox from Khronos's official glTF sample assets, with
 * baked-in Survey/Walk/Run animation clips.
 *
 * License: model CC0 (PixelMannen, opengameart.org/content/fox-and-shiba);
 * rig + animation CC-BY 4.0 (tomkranis on Sketchfab); glTF conversion by
 * AsoboStudio/scurest. Bundled at public/models/Fox.glb.
 */
const CLIP_FOR_ANIMATION: Record<string, string> = {
  idle: "Survey",
  listening: "Survey",
  thinking: "Walk",
  talking: "Walk",
  greeting: "Run",
  concerned: "Survey",
}

export default function FoxModel({ animation }: AvatarRenderProps) {
  const group = useRef<THREE.Group>(null)
  const { scene, animations } = useGLTF(FOX_URL)
  // Plain Object3D.clone() does not rebind a SkinnedMesh's skeleton to the
  // cloned bones - it keeps pointing at the shared cached scene's original
  // bones, which corrupts the skinned deformation. SkeletonUtils.clone()
  // clones the whole hierarchy AND rewires the skin binding correctly.
  const cloned = useMemo(() => SkeletonUtils.clone(scene), [scene])
  const { actions } = useAnimations(animations, group)

  useEffect(() => {
    cloned.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (mesh.isMesh) {
        mesh.castShadow = true
        mesh.receiveShadow = true
      }
    })
  }, [cloned])

  useEffect(() => {
    const clipName = CLIP_FOR_ANIMATION[animation] ?? "Survey"
    const action = actions[clipName]
    if (!action) return
    action.reset().fadeIn(0.35).play()
    return () => {
      action.fadeOut(0.35)
    }
  }, [animation, actions])

  return (
    <group ref={group} rotation={[0, Math.PI / 2, 0]}>
      <primitive object={cloned} position={FOX_OFFSET} scale={FOX_SCALE} />
    </group>
  )
}

useGLTF.preload(FOX_URL)
