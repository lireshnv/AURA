import { useMemo } from "react"
import { AnimatePresence, motion } from "framer-motion"
import { AvatarType } from "./types"

/** Deterministic pseudo-random in [0,1) from an integer seed - stable
 * across renders (no Math.random jitter/hydration mismatch), just enough
 * variation that particles don't look like a repeating grid. */
function seeded(n: number) {
  const x = Math.sin(n * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

interface ParticleSpec {
  left: string
  bottom: string
  size: number
  color: string
  dur: number
  delay: number
  driftX: number
  driftY: number
}

function makeParticles(count: number, seedBase: number, color: string, spread = 90, riseHeight = 70): ParticleSpec[] {
  return Array.from({ length: count }, (_, i) => {
    const s = seedBase + i * 7.31
    return {
      left: `${5 + seeded(s) * spread}%`,
      bottom: `${seeded(s + 1) * 40}%`,
      size: 2 + seeded(s + 2) * 3,
      color,
      dur: 5 + seeded(s + 3) * 6,
      delay: seeded(s + 4) * 6,
      driftX: (seeded(s + 5) - 0.5) * 30,
      driftY: -(riseHeight * 0.6 + seeded(s + 6) * riseHeight * 0.6),
    }
  })
}

function Particles({ items }: { items: ParticleSpec[] }) {
  return (
    <>
      {items.map((p, i) => (
        <span
          key={i}
          className="companion-particle absolute rounded-full pointer-events-none"
          style={
            {
              left: p.left,
              bottom: p.bottom,
              width: p.size,
              height: p.size,
              background: p.color,
              boxShadow: `0 0 ${p.size * 2}px ${p.color}`,
              "--dur": `${p.dur}s`,
              "--delay": `${p.delay}s`,
              "--drift-x": `${p.driftX}px`,
              "--drift-y": `${p.driftY}px`,
            } as React.CSSProperties
          }
        />
      ))}
    </>
  )
}

/** One themed, layered, continuously-animating habitat per companion type -
 * gradient sky, a soft directional glow, 1-2 theme-specific decorative
 * elements (fireflies/curtains/grass/petals/sunbeam), all CSS-driven so it
 * costs nothing extra in the WebGL scene. Rendered behind the transparent
 * 3D canvas; AnimatePresence crossfades the whole layer when the avatar
 * type changes so switching companions feels like entering a new space,
 * not a hard cut. */
export default function CompanionEnvironment({ avatarType }: { avatarType: AvatarType }) {
  const theme = THEME_FOR[avatarType] ?? THEME_FOR.orb
  const particles = useMemo(
    () => makeParticles(theme.particleCount, theme.seed, theme.particleColor, theme.spread, theme.riseHeight),
    [theme]
  )

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      <AnimatePresence mode="sync">
        <motion.div
          key={theme.key}
          className="absolute inset-0"
          initial={{ opacity: 0, scale: 1.03 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.9, ease: "easeInOut" }}
          style={{ background: theme.gradient }}
        >
          {/* Directional ambient light source - moon/sun/lamp depending on theme. */}
          <div
            className="companion-glow absolute rounded-full blur-3xl"
            style={{
              width: theme.glowSize,
              height: theme.glowSize,
              background: theme.glowColor,
              top: theme.glowTop,
              left: theme.glowLeft,
              right: theme.glowRight,
              "--dur": "7s",
            } as React.CSSProperties}
          />

          {theme.decoration}

          <Particles items={particles} />

          {/* Vignette so the animal stays the visual focus, not the scene. */}
          <div
            className="absolute inset-0"
            style={{ background: "radial-gradient(ellipse at 50% 65%, transparent 35%, rgba(0,0,0,0.35) 100%)" }}
          />
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

interface Theme {
  key: string
  gradient: string
  glowColor: string
  glowSize: string
  glowTop?: string
  glowLeft?: string
  glowRight?: string
  particleColor: string
  particleCount: number
  spread: number
  riseHeight: number
  seed: number
  decoration?: React.ReactNode
}

function LeafBlob({ style }: { style: React.CSSProperties }) {
  return (
    <div
      className="companion-sway absolute rounded-[45%_55%_60%_40%] blur-md"
      style={{ background: "radial-gradient(circle, rgba(74,124,46,0.55), rgba(30,58,20,0) 70%)", ...style }}
    />
  )
}

function Curtain({ side }: { side: "left" | "right" }) {
  return (
    <div
      className="companion-sway absolute top-0 bottom-0 blur-[1px]"
      style={{
        [side]: "-4%",
        width: "22%",
        background:
          side === "left"
            ? "linear-gradient(105deg, rgba(30,32,64,0.55), rgba(30,32,64,0) 70%)"
            : "linear-gradient(255deg, rgba(30,32,64,0.55), rgba(30,32,64,0) 70%)",
        "--dur": "7s",
        "--sway-from": side === "left" ? "-1.5deg" : "1.5deg",
        "--sway-to": side === "left" ? "1.5deg" : "-1.5deg",
      } as React.CSSProperties}
    />
  )
}

function GrassRow({ color }: { color: string }) {
  return (
    <div className="absolute bottom-0 left-0 right-0 h-[22%] flex items-end justify-around overflow-hidden">
      {Array.from({ length: 14 }, (_, i) => (
        <div
          key={i}
          className="companion-sway rounded-t-full"
          style={{
            width: 3 + seeded(i * 3) * 3,
            height: `${30 + seeded(i * 5) * 55}%`,
            background: color,
            opacity: 0.5 + seeded(i * 9) * 0.3,
            "--dur": `${3.2 + seeded(i * 11) * 2}s`,
            "--delay": `${seeded(i * 13) * 2}s`,
            "--sway-from": "-4deg",
            "--sway-to": "4deg",
          } as React.CSSProperties}
        />
      ))}
    </div>
  )
}

function Sunbeam() {
  return (
    <div
      className="companion-glow absolute -top-[10%] left-[15%] w-[45%] h-[130%] blur-2xl"
      style={{
        background: "linear-gradient(200deg, rgba(255,214,140,0.28), rgba(255,214,140,0) 65%)",
        transform: "rotate(12deg)",
        "--dur": "8s",
      } as React.CSSProperties}
    />
  )
}

function Flowers() {
  return (
    <div className="absolute bottom-[4%] left-0 right-0 h-[18%] flex items-end justify-around">
      {Array.from({ length: 8 }, (_, i) => (
        <span
          key={i}
          className="companion-sway rounded-full"
          style={{
            width: 8 + seeded(i * 4) * 5,
            height: 8 + seeded(i * 4) * 5,
            background: i % 3 === 0 ? "#f4c2d9" : i % 3 === 1 ? "#e8d97a" : "#c9b6f0",
            boxShadow: "0 0 8px rgba(255,255,255,0.25)",
            marginBottom: `${seeded(i * 6) * 20}%`,
            "--dur": `${4 + seeded(i * 8) * 2}s`,
            "--sway-from": "-3deg",
            "--sway-to": "3deg",
          } as React.CSSProperties}
        />
      ))}
    </div>
  )
}

const THEME_FOR: Record<string, Theme> = {
  // Soft forest, sunset light through the trees, fireflies at dusk.
  fox: {
    key: "fox",
    gradient:
      "linear-gradient(180deg, #0e1a12 0%, #16261a 35%, #3a2a1a 75%, #5a3a20 100%)",
    glowColor: "radial-gradient(circle, rgba(255,170,90,0.55), rgba(255,170,90,0) 70%)",
    glowSize: "70%",
    glowTop: "55%",
    glowLeft: "20%",
    particleColor: "#ffd27a",
    particleCount: 10,
    spread: 85,
    riseHeight: 55,
    seed: 11,
    decoration: (
      <>
        <LeafBlob style={{ width: 160, height: 120, top: "-4%", left: "-6%" }} />
        <LeafBlob style={{ width: 130, height: 100, top: "2%", right: "-4%", animationDelay: "1.2s" }} />
      </>
    ),
  },
  // Cozy moonlit room, a peaceful window, softly moving curtains.
  cat: {
    key: "cat",
    gradient: "linear-gradient(180deg, #0a0d1f 0%, #12172f 55%, #191d33 100%)",
    glowColor: "radial-gradient(circle, rgba(200,215,255,0.5), rgba(200,215,255,0) 70%)",
    glowSize: "40%",
    glowTop: "-6%",
    glowRight: "5%",
    particleColor: "#dfe6ff",
    particleCount: 8,
    spread: 60,
    riseHeight: 40,
    seed: 23,
    decoration: (
      <>
        <Curtain side="left" />
        <Curtain side="right" />
      </>
    ),
  },
  // Warm outdoor meadow, moving grass, floating dust in the light.
  dog: {
    key: "dog",
    gradient: "linear-gradient(180deg, #cfe8c9 0%, #a9d6a0 30%, #7bb86e 65%, #5a9a4e 100%)",
    glowColor: "radial-gradient(circle, rgba(255,244,200,0.6), rgba(255,244,200,0) 70%)",
    glowSize: "55%",
    glowTop: "-8%",
    glowLeft: "-4%",
    particleColor: "#fff6d6",
    particleCount: 12,
    spread: 90,
    riseHeight: 60,
    seed: 37,
    decoration: <GrassRow color="#4a7d3e" />,
  },
  // Calm garden/meadow with flowers, gently moving grass.
  rabbit: {
    key: "rabbit",
    gradient: "linear-gradient(180deg, #e9e4f7 0%, #d6ecd2 45%, #bfe0c4 100%)",
    glowColor: "radial-gradient(circle, rgba(255,255,255,0.55), rgba(255,255,255,0) 70%)",
    glowSize: "50%",
    glowTop: "-6%",
    glowLeft: "30%",
    particleColor: "#ffffff",
    particleCount: 8,
    spread: 85,
    riseHeight: 35,
    seed: 51,
    decoration: (
      <>
        <GrassRow color="#7fbf7a" />
        <Flowers />
      </>
    ),
  },
  // Warm greenhouse light, dust motes drifting through a sunbeam.
  plant: {
    key: "plant",
    gradient: "linear-gradient(180deg, #1c2416 0%, #2c3a1f 45%, #46512a 100%)",
    glowColor: "radial-gradient(circle, rgba(255,214,140,0.35), rgba(255,214,140,0) 70%)",
    glowSize: "60%",
    glowTop: "-10%",
    glowLeft: "10%",
    particleColor: "#f2e6b8",
    particleCount: 9,
    spread: 70,
    riseHeight: 50,
    seed: 63,
    decoration: <Sunbeam />,
  },
  // Default / Orb / Robot / Custom - the app's existing quiet cosmic void.
  orb: {
    key: "orb",
    gradient: "linear-gradient(180deg, #0a0714 0%, #150f28 55%, #1c1436 100%)",
    glowColor: "radial-gradient(circle, rgba(167,139,250,0.4), rgba(167,139,250,0) 70%)",
    glowSize: "65%",
    glowTop: "10%",
    glowLeft: "20%",
    particleColor: "#c4b5fd",
    particleCount: 14,
    spread: 95,
    riseHeight: 45,
    seed: 5,
  },
}
