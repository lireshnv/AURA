import { useEffect, useState } from "react"
import { AvatarType } from "./types"

const TYPE_KEY = "aura-avatar-type"
const IDENTITY_EVENT = "aura-avatar-identity-change"

function readType(): AvatarType {
  try {
    return (localStorage.getItem(TYPE_KEY) as AvatarType) || "dog"
  } catch {
    return "dog"
  }
}

/**
 * Shared avatar identity (just the type - the companion is always one of the
 * procedural animal/plant models, never a photorealistic human), kept in
 * sync across every mounted AvatarModule instance on the page - e.g. the
 * full module and the compact preview both reflect the same avatar the
 * person actually picked, live, with no reload.
 */
export function useAvatarIdentity() {
  const [avatarType, setAvatarTypeState] = useState<AvatarType>(readType)

  useEffect(() => {
    const onChange = () => setAvatarTypeState(readType())
    window.addEventListener(IDENTITY_EVENT, onChange)
    return () => window.removeEventListener(IDENTITY_EVENT, onChange)
  }, [])

  const setAvatarType = (t: AvatarType) => {
    try {
      localStorage.setItem(TYPE_KEY, t)
    } catch {
      /* storage disabled - selection just won't persist or sync */
    }
    setAvatarTypeState(t)
    window.dispatchEvent(new Event(IDENTITY_EVENT))
  }

  return { avatarType, setAvatarType }
}
