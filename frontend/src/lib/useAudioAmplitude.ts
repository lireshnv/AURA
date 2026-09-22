import { RefObject, useEffect, useRef, useState } from "react"

/**
 * Real-time amplitude (0-1) of whatever audio is currently playing through
 * the given <audio> element, sampled via Web Audio's AnalyserNode.
 *
 * This drives the avatar's mouth openness from the ACTUAL spoken audio
 * rather than a fake timed animation - an honest approximation of lip-sync
 * (volume-driven, not phoneme-driven) without a viseme model.
 */
export function useAudioAmplitude(audioRef: RefObject<HTMLAudioElement | null>): number {
  const [amplitude, setAmplitude] = useState(0)
  const ctxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!AudioCtx) return

    // Reuse a single context/source across the element's lifetime - a
    // MediaElementAudioSourceNode can only be created once per element.
    if (!ctxRef.current) {
      try {
        const ctx = new AudioCtx()
        const source = ctx.createMediaElementSource(audio)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 256
        analyser.smoothingTimeConstant = 0.6
        source.connect(analyser)
        analyser.connect(ctx.destination)
        ctxRef.current = ctx
        sourceRef.current = source
        analyserRef.current = analyser
      } catch {
        // Cross-origin or unsupported - the avatar falls back to no
        // amplitude data and simply doesn't animate the mouth by volume.
        return
      }
    }

    const analyser = analyserRef.current
    if (!analyser) return
    const data = new Uint8Array(analyser.frequencyBinCount)

    const tick = () => {
      analyser.getByteTimeDomainData(data)
      let sumSquares = 0
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128
        sumSquares += v * v
      }
      const rms = Math.sqrt(sumSquares / data.length)
      setAmplitude(Math.min(1, rms * 4))
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [audioRef])

  useEffect(() => {
    return () => {
      ctxRef.current?.close().catch(() => {})
    }
  }, [])

  return amplitude
}
