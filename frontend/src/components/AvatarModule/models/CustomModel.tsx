import { Component, ReactNode, useEffect, useMemo, useRef } from "react"
import { useGLTF } from "@react-three/drei"
import { useFrame } from "@react-three/fiber"
import * as THREE from "three"
import { SkeletonUtils } from "three-stdlib"
import { AvatarRenderProps } from "../types"
import { FallbackModel } from "./ProceduralAvatars"

export class ModelErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/** A user-uploaded GLB/GLTF, auto-centered and scaled to fit the viewer.
 * Any morph targets it has are driven the same way as the human avatar's. */
function UploadedModel({ url, animation, amplitude, lipSyncEnabled }: AvatarRenderProps & { url: string }) {
  const { scene } = useGLTF(url)
  // Plain Object3D.clone() doesn't rebind a SkinnedMesh's skeleton to the
  // cloned bones (it keeps the shared cached scene's original bones), which
  // corrupts skinning for any rigged upload - SkeletonUtils.clone() rewires
  // the skin binding correctly. Harmless no-op for a non-rigged model.
  const cloned = useMemo(() => SkeletonUtils.clone(scene), [scene])
  const meshesWithMorphs = useRef<THREE.Mesh[]>([])

  const { centered, scale } = useMemo(() => {
    const box = new THREE.Box3().setFromObject(cloned)
    const size = new THREE.Vector3()
    box.getSize(size)
    const center = new THREE.Vector3()
    box.getCenter(center)
    const maxDim = Math.max(size.x, size.y, size.z, 0.01)
    return { centered: center, scale: 1.6 / maxDim }
  }, [cloned])

  useEffect(() => {
    const found: THREE.Mesh[] = []
    cloned.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (mesh.isMesh && mesh.morphTargetDictionary && mesh.morphTargetInfluences) found.push(mesh)
    })
    meshesWithMorphs.current = found
  }, [cloned])

  useFrame(() => {
    const talkOpen =
      animation === "talking" && lipSyncEnabled ? Math.min(1, amplitude * 1.6) : animation === "talking" ? 0.25 : 0
    for (const mesh of meshesWithMorphs.current) {
      const dict = mesh.morphTargetDictionary!
      const infl = mesh.morphTargetInfluences!
      for (const [name, idx] of Object.entries(dict)) {
        if (name.toLowerCase().includes("mouth") || name.toLowerCase().includes("jaw")) {
          infl[idx] = THREE.MathUtils.lerp(infl[idx], talkOpen, 0.25)
        }
      }
    }
  })

  return (
    <primitive
      object={cloned}
      position={[-centered.x * scale, -centered.y * scale, -centered.z * scale]}
      scale={scale}
    />
  )
}

export default function CustomModel(props: AvatarRenderProps & { glbUrl: string | null }) {
  const { glbUrl, ...rest } = props
  if (!glbUrl) {
    // Nothing uploaded yet - a neutral placeholder rather than an empty scene.
    return <FallbackModel {...rest} />
  }
  return (
    <ModelErrorBoundary fallback={<FallbackModel {...rest} />}>
      <UploadedModel url={glbUrl} {...rest} />
    </ModelErrorBoundary>
  )
}
