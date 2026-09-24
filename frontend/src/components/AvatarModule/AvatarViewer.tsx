import { Suspense, useState } from "react"
import { Canvas } from "@react-three/fiber"
import { ContactShadows, OrbitControls } from "@react-three/drei"
import { AvatarRenderProps, AvatarType } from "./types"
import CustomModel, { ModelErrorBoundary } from "./models/CustomModel"
import FoxModel from "./models/FoxModel"
import PlantModel from "./models/PlantModel"
import { DogModel, CatModel, RabbitModel, RobotModel, OrbModel, FallbackModel } from "./models/ProceduralAvatars"
import CompanionEnvironment from "./CompanionEnvironment"

interface Props extends AvatarRenderProps {
  avatarType: AvatarType
  customGlbUrl: string | null
  /** Off for small read-only previews (e.g. the Daily Care card) so a stray
   * drag doesn't spin someone else's view of the same shared avatar state. */
  interactive?: boolean
}

function SceneAvatar({ avatarType, customGlbUrl, ...render }: Props) {
  switch (avatarType) {
    case "fox":
      return (
        <ModelErrorBoundary fallback={<DogModel {...render} />}>
          <FoxModel {...render} />
        </ModelErrorBoundary>
      )
    case "plant":
      return (
        <ModelErrorBoundary fallback={<FallbackModel {...render} />}>
          <PlantModel {...render} />
        </ModelErrorBoundary>
      )
    case "dog":
      return <DogModel {...render} />
    case "cat":
      return <CatModel {...render} />
    case "rabbit":
      return <RabbitModel {...render} />
    case "robot":
      return <RobotModel {...render} />
    case "orb":
      return <OrbModel {...render} />
    case "custom":
      return <CustomModel glbUrl={customGlbUrl} {...render} />
    default:
      return <FallbackModel {...render} />
  }
}

/**
 * The single 3D viewport. Every avatar type renders through this one Canvas -
 * switching types swaps the model, never the surrounding module/UI.
 */
export default function AvatarViewer({ interactive = true, ...props }: Props) {
  const [loadFailed, setLoadFailed] = useState(false)

  return (
    <div className="relative w-full h-full rounded-2xl overflow-hidden">
      <CompanionEnvironment avatarType={props.avatarType} />
      <Canvas shadows camera={{ position: [0, -0.15, 3.7], fov: 34 }} dpr={[1, 2]} gl={{ alpha: true }} className="!absolute inset-0">
        {/* Local lighting only - no HDRI/network fetch, so the viewer never
            hangs on a blocked or slow request. */}
        <hemisphereLight intensity={0.6} color="#f5f3ff" groundColor="#2b2033" />
        <ambientLight intensity={0.35} />
        <directionalLight
          position={[2, 3, 2]}
          intensity={1.2}
          castShadow
          shadow-mapSize-width={1024}
          shadow-mapSize-height={1024}
        />
        <directionalLight position={[-2, 1, -1.5]} intensity={0.4} color="#a78bfa" />
        <pointLight position={[0, 1.5, 2]} intensity={0.3} color="#ffffff" />
        <Suspense fallback={<FallbackModel {...props} onError={undefined} />}>
          <SceneAvatar {...props} key={loadFailed ? "fallback" : props.avatarType} onError={() => setLoadFailed(true)} />
          <ContactShadows position={[0, -1.68, 0]} opacity={0.35} scale={4.5} blur={2.4} far={2} />
        </Suspense>
        {interactive && (
          <OrbitControls
            enablePan={false}
            enableZoom={true}
            minDistance={2.4}
            maxDistance={5.2}
            minPolarAngle={Math.PI / 2.6}
            maxPolarAngle={Math.PI / 1.9}
            target={[0, -0.15, 0]}
          />
        )}
      </Canvas>
    </div>
  )
}
