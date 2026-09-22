import { useRef } from "react"
import { useFrame } from "@react-three/fiber"
import * as THREE from "three"
import { AvatarRenderProps, Expression } from "../types"

/**
 * Clean, lit, real 3D geometry (not flat art) for avatar types that don't yet
 * have a licensed GLB model. Stylized rather than photorealistic - swapping
 * in a real model later only means adding a case in AvatarViewer, the rest
 * of the module (expression/animation/lip-sync plumbing) is unchanged.
 */

const EXPRESSION_MOUTH_CURVE: Record<Expression, number> = {
  natural: 0,
  happy: 0.6,
  sad: -0.5,
  concerned: -0.3,
  angry: -0.4,
  surprised: 0.2,
  calm: 0.1,
  neutral: 0,
}

function useBlink(eyeLeftRef: React.RefObject<THREE.Mesh>, eyeRightRef: React.RefObject<THREE.Mesh>) {
  const nextBlink = useRef(2 + Math.random() * 3)
  const blinking = useRef(false)
  const blinkT = useRef(0)

  useFrame((_, delta) => {
    nextBlink.current -= delta
    if (nextBlink.current <= 0 && !blinking.current) {
      blinking.current = true
      blinkT.current = 0
    }
    if (blinking.current) {
      blinkT.current += delta
      const p = blinkT.current / 0.16
      const scaleY = p < 0.5 ? 1 - p * 2 : (p - 0.5) * 2
      if (eyeLeftRef.current) eyeLeftRef.current.scale.y = Math.max(0.05, scaleY)
      if (eyeRightRef.current) eyeRightRef.current.scale.y = Math.max(0.05, scaleY)
      if (blinkT.current >= 0.16) {
        blinking.current = false
        nextBlink.current = 2.5 + Math.random() * 3
        if (eyeLeftRef.current) eyeLeftRef.current.scale.y = 1
        if (eyeRightRef.current) eyeRightRef.current.scale.y = 1
      }
    }
  })
}

function IdleBob({ children, groupRef }: { children: React.ReactNode; groupRef: React.RefObject<THREE.Group> }) {
  useFrame(({ clock }) => {
    if (!groupRef.current) return
    groupRef.current.position.y = Math.sin(clock.elapsedTime * 1.2) * 0.04
    groupRef.current.rotation.y = Math.sin(clock.elapsedTime * 0.4) * 0.06
  })
  return <group ref={groupRef}>{children}</group>
}

function useMouthAnimation(
  mouthRef: React.RefObject<THREE.Mesh>,
  animation: string,
  amplitude: number,
  lipSyncEnabled: boolean,
  expression: Expression
) {
  useFrame(() => {
    if (!mouthRef.current) return
    const base = 0.06
    const open =
      animation === "talking" && lipSyncEnabled ? base + amplitude * 0.35 : animation === "talking" ? base + 0.1 : base
    mouthRef.current.scale.y = THREE.MathUtils.lerp(mouthRef.current.scale.y, open, 0.3)
    mouthRef.current.rotation.z = EXPRESSION_MOUTH_CURVE[expression] * 0.3
  })
}

export function DogModel({ expression, animation, amplitude, lipSyncEnabled }: AvatarRenderProps) {
  const group = useRef<THREE.Group>(null)
  const eyeL = useRef<THREE.Mesh>(null)
  const eyeR = useRef<THREE.Mesh>(null)
  const mouth = useRef<THREE.Mesh>(null)
  const earL = useRef<THREE.Mesh>(null)
  const earR = useRef<THREE.Mesh>(null)
  const tail = useRef<THREE.Mesh>(null)
  useBlink(eyeL, eyeR)
  useMouthAnimation(mouth, animation, amplitude, lipSyncEnabled, expression)

  useFrame(({ clock }) => {
    const t = clock.elapsedTime
    const wag = animation === "talking" || animation === "greeting" ? 6 : 1.5
    if (tail.current) tail.current.rotation.z = Math.sin(t * wag) * 0.3
    if (earL.current) earL.current.rotation.z = 0.3 + Math.sin(t * 2) * 0.05
    if (earR.current) earR.current.rotation.z = -0.3 - Math.sin(t * 2) * 0.05
  })

  return (
    <IdleBob groupRef={group}>
      <mesh position={[0, 0, 0]} castShadow>
        <sphereGeometry args={[0.9, 32, 32]} />
        <meshStandardMaterial color="#c9a06a" roughness={0.85} />
      </mesh>
      <mesh position={[0, 0.15, 0.85]} castShadow>
        <boxGeometry args={[0.55, 0.5, 0.55]} />
        <meshStandardMaterial color="#d8b27e" roughness={0.85} />
      </mesh>
      <mesh position={[0, -0.05, 1.25]} castShadow>
        <sphereGeometry args={[0.16, 16, 16]} />
        <meshStandardMaterial color="#4b3621" roughness={0.6} />
      </mesh>
      <mesh ref={eyeL} position={[-0.18, 0.2, 1.1]}>
        <sphereGeometry args={[0.08, 12, 12]} />
        <meshStandardMaterial color="#2b1a0e" />
      </mesh>
      <mesh ref={eyeR} position={[0.18, 0.2, 1.1]}>
        <sphereGeometry args={[0.08, 12, 12]} />
        <meshStandardMaterial color="#2b1a0e" />
      </mesh>
      <mesh ref={mouth} position={[0, -0.15, 1.15]}>
        <boxGeometry args={[0.2, 0.08, 0.1]} />
        <meshStandardMaterial color="#5a2a2a" roughness={0.7} />
      </mesh>
      <mesh ref={earL} position={[-0.4, 0.55, 0.75]} rotation={[0, 0, 0.3]} castShadow>
        <coneGeometry args={[0.18, 0.4, 16]} />
        <meshStandardMaterial color="#a8825a" roughness={0.85} />
      </mesh>
      <mesh ref={earR} position={[0.4, 0.55, 0.75]} rotation={[0, 0, -0.3]} castShadow>
        <coneGeometry args={[0.18, 0.4, 16]} />
        <meshStandardMaterial color="#a8825a" roughness={0.85} />
      </mesh>
      <mesh ref={tail} position={[0, 0.1, -0.9]} rotation={[0.6, 0, 0]} castShadow>
        <coneGeometry args={[0.1, 0.5, 12]} />
        <meshStandardMaterial color="#c9a06a" roughness={0.85} />
      </mesh>
    </IdleBob>
  )
}

export function CatModel({ expression, animation, amplitude, lipSyncEnabled }: AvatarRenderProps) {
  const group = useRef<THREE.Group>(null)
  const eyeL = useRef<THREE.Mesh>(null)
  const eyeR = useRef<THREE.Mesh>(null)
  const mouth = useRef<THREE.Mesh>(null)
  const tail = useRef<THREE.Mesh>(null)
  useBlink(eyeL, eyeR)
  useMouthAnimation(mouth, animation, amplitude, lipSyncEnabled, expression)

  useFrame(({ clock }) => {
    const t = clock.elapsedTime
    if (tail.current) tail.current.rotation.y = Math.sin(t * 1.5) * 0.4
  })

  return (
    <IdleBob groupRef={group}>
      <mesh castShadow>
        <sphereGeometry args={[0.85, 32, 32]} />
        <meshStandardMaterial color="#6b6b6f" roughness={0.9} />
      </mesh>
      <mesh position={[0, 0.2, 0.8]} castShadow>
        <sphereGeometry args={[0.42, 24, 24]} />
        <meshStandardMaterial color="#78787c" roughness={0.9} />
      </mesh>
      <mesh position={[-0.22, 0.55, 0.65]} rotation={[0, 0, 0.2]} castShadow>
        <coneGeometry args={[0.14, 0.3, 3]} />
        <meshStandardMaterial color="#6b6b6f" roughness={0.9} />
      </mesh>
      <mesh position={[0.22, 0.55, 0.65]} rotation={[0, 0, -0.2]} castShadow>
        <coneGeometry args={[0.14, 0.3, 3]} />
        <meshStandardMaterial color="#6b6b6f" roughness={0.9} />
      </mesh>
      <mesh ref={eyeL} position={[-0.16, 0.22, 1.15]}>
        <sphereGeometry args={[0.09, 12, 12]} />
        <meshStandardMaterial color="#a8e063" emissive="#3d5a1e" emissiveIntensity={0.3} />
      </mesh>
      <mesh ref={eyeR} position={[0.16, 0.22, 1.15]}>
        <sphereGeometry args={[0.09, 12, 12]} />
        <meshStandardMaterial color="#a8e063" emissive="#3d5a1e" emissiveIntensity={0.3} />
      </mesh>
      <mesh ref={mouth} position={[0, 0.02, 1.2]}>
        <boxGeometry args={[0.16, 0.05, 0.08]} />
        <meshStandardMaterial color="#4a3a3a" />
      </mesh>
      <mesh ref={tail} position={[0, 0.1, -0.85]} rotation={[0.9, 0, 0]} castShadow>
        <cylinderGeometry args={[0.07, 0.1, 0.7, 12]} />
        <meshStandardMaterial color="#6b6b6f" roughness={0.9} />
      </mesh>
    </IdleBob>
  )
}

export function RobotModel({ expression, animation, amplitude, lipSyncEnabled }: AvatarRenderProps) {
  const group = useRef<THREE.Group>(null)
  const eyeL = useRef<THREE.Mesh>(null)
  const eyeR = useRef<THREE.Mesh>(null)
  const mouth = useRef<THREE.Mesh>(null)
  const antenna = useRef<THREE.Mesh>(null)
  useMouthAnimation(mouth, animation, amplitude, lipSyncEnabled, expression)

  useFrame(({ clock }) => {
    const t = clock.elapsedTime
    const pulse = 0.6 + Math.sin(t * 4) * 0.4
    const mat = antenna.current?.material as THREE.MeshStandardMaterial | undefined
    if (mat) mat.emissiveIntensity = animation === "thinking" ? pulse : 0.6
    if (eyeL.current) (eyeL.current.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.8
    if (eyeR.current) (eyeR.current.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.8
  })

  return (
    <IdleBob groupRef={group}>
      <mesh castShadow>
        <boxGeometry args={[0.9, 1, 0.7]} />
        <meshStandardMaterial color="#dfe3e8" metalness={0.7} roughness={0.3} />
      </mesh>
      <mesh position={[0, 0.85, 0]} castShadow>
        <boxGeometry args={[0.7, 0.6, 0.65]} />
        <meshStandardMaterial color="#f2f4f7" metalness={0.6} roughness={0.25} />
      </mesh>
      <mesh ref={eyeL} position={[-0.16, 0.85, 0.34]}>
        <circleGeometry args={[0.09, 20]} />
        <meshStandardMaterial color="#630ed4" emissive="#7c3aed" emissiveIntensity={0.8} />
      </mesh>
      <mesh ref={eyeR} position={[0.16, 0.85, 0.34]}>
        <circleGeometry args={[0.09, 20]} />
        <meshStandardMaterial color="#630ed4" emissive="#7c3aed" emissiveIntensity={0.8} />
      </mesh>
      <mesh ref={mouth} position={[0, 0.65, 0.34]}>
        <boxGeometry args={[0.28, 0.06, 0.02]} />
        <meshStandardMaterial color="#630ed4" emissive="#7c3aed" emissiveIntensity={0.6} />
      </mesh>
      <mesh position={[0, 1.2, 0]} castShadow>
        <cylinderGeometry args={[0.03, 0.03, 0.3, 8]} />
        <meshStandardMaterial color="#9aa1ab" metalness={0.8} roughness={0.3} />
      </mesh>
      <mesh ref={antenna} position={[0, 1.4, 0]}>
        <sphereGeometry args={[0.07, 16, 16]} />
        <meshStandardMaterial color="#7c3aed" emissive="#7c3aed" emissiveIntensity={0.6} />
      </mesh>
      <mesh position={[-0.6, 0.1, 0]} castShadow>
        <boxGeometry args={[0.18, 0.5, 0.3]} />
        <meshStandardMaterial color="#c7cbd1" metalness={0.6} roughness={0.35} />
      </mesh>
      <mesh position={[0.6, 0.1, 0]} castShadow>
        <boxGeometry args={[0.18, 0.5, 0.3]} />
        <meshStandardMaterial color="#c7cbd1" metalness={0.6} roughness={0.35} />
      </mesh>
    </IdleBob>
  )
}

export function PlantModel({ animation }: AvatarRenderProps) {
  const group = useRef<THREE.Group>(null)
  const leaves = useRef<THREE.Group>(null)

  useFrame(({ clock }) => {
    const t = clock.elapsedTime
    const sway = animation === "talking" ? 0.12 : 0.05
    if (leaves.current) leaves.current.rotation.z = Math.sin(t * 1.1) * sway
    if (group.current) group.current.position.y = Math.sin(t * 0.9) * 0.03
  })

  const leafPositions: [number, number, number, number][] = [
    [0, 0.9, 0, 0],
    [0.25, 0.7, 0.1, 0.6],
    [-0.25, 0.65, -0.1, -0.6],
    [0, 0.5, 0.28, 1.4],
    [0, 0.5, -0.28, -1.4],
  ]

  return (
    <group ref={group}>
      <mesh position={[0, -0.55, 0]} castShadow>
        <cylinderGeometry args={[0.55, 0.65, 0.5, 24]} />
        <meshStandardMaterial color="#b98a5a" roughness={0.9} />
      </mesh>
      <mesh position={[0, -0.32, 0]}>
        <cylinderGeometry args={[0.5, 0.55, 0.06, 24]} />
        <meshStandardMaterial color="#4d3b28" roughness={1} />
      </mesh>
      <group ref={leaves}>
        <mesh position={[0, -0.1, 0]} castShadow>
          <cylinderGeometry args={[0.04, 0.05, 0.8, 8]} />
          <meshStandardMaterial color="#4d7c2e" roughness={0.8} />
        </mesh>
        {leafPositions.map(([x, y, z, rot], i) => (
          <mesh key={i} position={[x, y, z]} rotation={[0.3, rot, 0.4]} castShadow>
            <sphereGeometry args={[0.3, 16, 16, 0, Math.PI]} />
            <meshStandardMaterial color={i % 2 === 0 ? "#5a9337" : "#4d7c2e"} roughness={0.75} side={THREE.DoubleSide} />
          </mesh>
        ))}
      </group>
    </group>
  )
}

/** Generic bust shown only while a model is still loading, or for an
 * unrecognized avatar type - never a broken/blank viewer. */
export function FallbackModel({ expression, animation, amplitude, lipSyncEnabled }: AvatarRenderProps) {
  const group = useRef<THREE.Group>(null)
  const eyeL = useRef<THREE.Mesh>(null)
  const eyeR = useRef<THREE.Mesh>(null)
  const mouth = useRef<THREE.Mesh>(null)
  useBlink(eyeL, eyeR)
  useMouthAnimation(mouth, animation, amplitude, lipSyncEnabled, expression)

  return (
    <IdleBob groupRef={group}>
      <mesh position={[0, -0.75, 0]} castShadow>
        <cylinderGeometry args={[0.55, 0.7, 0.9, 32]} />
        <meshStandardMaterial color="#5b4636" roughness={0.7} />
      </mesh>
      <mesh position={[0, 0.05, 0]} castShadow>
        <sphereGeometry args={[0.52, 32, 32]} />
        <meshStandardMaterial color="#e8b892" roughness={0.6} />
      </mesh>
      <mesh position={[0, 0.5, 0]} castShadow>
        <sphereGeometry args={[0.54, 32, 32, 0, Math.PI * 2, 0, Math.PI * 0.55]} />
        <meshStandardMaterial color="#2b2018" roughness={0.8} />
      </mesh>
      <mesh ref={eyeL} position={[-0.18, 0.08, 0.46]}>
        <sphereGeometry args={[0.06, 12, 12]} />
        <meshStandardMaterial color="#2b1a0e" />
      </mesh>
      <mesh ref={eyeR} position={[0.18, 0.08, 0.46]}>
        <sphereGeometry args={[0.06, 12, 12]} />
        <meshStandardMaterial color="#2b1a0e" />
      </mesh>
      <mesh ref={mouth} position={[0, -0.22, 0.48]}>
        <boxGeometry args={[0.22, 0.06, 0.06]} />
        <meshStandardMaterial color="#8a4a4a" roughness={0.6} />
      </mesh>
    </IdleBob>
  )
}
