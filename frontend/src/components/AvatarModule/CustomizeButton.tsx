import { useRef } from "react"
import { AvatarType } from "./types"

export default function CustomizeButton({
  avatarType,
  onCustomAvatarUploaded,
}: {
  avatarType: AvatarType
  onCustomAvatarUploaded: (url: string) => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  if (avatarType === "custom") {
    return (
      <>
        <input
          ref={fileInputRef}
          type="file"
          accept=".glb,.gltf"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) onCustomAvatarUploaded(URL.createObjectURL(file))
          }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          className="w-full px-4 py-2 rounded-full bg-primary hover:bg-primary-fixed-dim text-on-primary text-label-md font-semibold"
        >
          Upload .glb / .gltf
        </button>
      </>
    )
  }

  return (
    <button
      disabled
      title="Photorealistic customization for this avatar type isn't available yet — a stylized 3D preview is shown."
      className="w-full px-4 py-2 rounded-full border border-outline-variant text-on-surface-variant text-label-md font-semibold opacity-50 cursor-not-allowed"
    >
      Customize
    </button>
  )
}
