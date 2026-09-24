import { useEffect, useMemo, useRef } from "react"
import { useFrame } from "@react-three/fiber"
import { useGLTF } from "@react-three/drei"
import * as THREE from "three"
import { SkeletonUtils } from "three-stdlib"
import { AvatarRenderProps } from "../types"

const PLANT_URL = "/models/Plant.glb"

/**
 * A real 3D asset (not hand-built primitive geometry), same treatment as
 * FoxModel: Khronos's own official glTF sample asset library, CC0.
 *
 * License: CC0 1.0 (Khronos Group glTF-Sample-Assets, "DiffuseTransmissionPlant").
 * Bundled at public/models/Plant.glb.
 */
export default function PlantModel({ animation }: AvatarRenderProps) {
  const group = useRef<THREE.Group>(null)
  const leaves = useRef<THREE.Group>(null)
  const { scene } = useGLTF(PLANT_URL)
  const cloned = useMemo(() => SkeletonUtils.clone(scene), [scene])

  useEffect(() => {
    const GROUND_Y = -1.68
    const box = new THREE.Box3().setFromObject(cloned)
    const size = new THREE.Vector3()
    box.getSize(size)
    const scale = size.y > 0 ? 2.6 / size.y : 1
    cloned.scale.setScalar(scale)
    const scaledBox = new THREE.Box3().setFromObject(cloned)
    cloned.position.y = GROUND_Y - scaledBox.min.y
    cloned.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (mesh.isMesh) {
        mesh.castShadow = true
        mesh.receiveShadow = true
      }
    })
  }, [cloned])

  useFrame(({ clock }) => {
    const t = clock.elapsedTime
    const sway = animation === "talking" ? 0.05 : 0.02
    if (leaves.current) leaves.current.rotation.z = Math.sin(t * 1.1) * sway
    if (group.current) group.current.position.y = Math.sin(t * 0.9) * 0.02
  })

  return (
    <group ref={group}>
      <group ref={leaves}>
        <primitive object={cloned} />
      </group>
    </group>
  )
}

useGLTF.preload(PLANT_URL)
