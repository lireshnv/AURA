/**
 * Low-level, provider-agnostic PCM16 playback primitives shared by every
 * streaming-audio path in Aura (ElevenLabs sentence streaming in
 * streamingSpeech.ts, and Gemini Live's continuous realtime audio in
 * useRealtimeVoiceConversation.ts). Knows nothing about HTTP, WebSockets,
 * word-alignment or any specific provider - just "decode base64 PCM16" and
 * "schedule chunks back-to-back on a Web Audio graph with no gaps."
 */

/** Decodes raw 16-bit signed little-endian PCM bytes into normalized
 * [-1, 1] float samples. Sample-rate-agnostic - the rate only matters when
 * the samples are handed to createChunkScheduler/AudioBuffer. Use this
 * directly for binary WS frames (e.g. Gemini Live's audio-out) - no reason
 * to round-trip through base64 when the bytes are already raw. */
export function decodePcm16Bytes(bytes: ArrayBuffer | Uint8Array): Float32Array {
  const view = bytes instanceof Uint8Array ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new DataView(bytes)
  const sampleCount = Math.floor(view.byteLength / 2)
  const out = new Float32Array(sampleCount)
  for (let i = 0; i < sampleCount; i++) {
    out[i] = view.getInt16(i * 2, true) / 32768
  }
  return out
}

/** Decodes base64-encoded 16-bit signed little-endian PCM (used where the
 * transport is JSON/NDJSON, e.g. the ElevenLabs streaming-TTS endpoint). */
export function decodePcm16(base64: string): Float32Array {
  const binary = atob(base64)
  const len = binary.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i)
  return decodePcm16Bytes(bytes)
}

export interface ScheduledChunk {
  source: AudioBufferSourceNode
  /** Seconds from the scheduler's timeline start (its first-ever chunk) to
   * where THIS chunk actually starts playing - exact, not approximated from
   * "now" at call time, since chunks are scheduled ahead of "now". */
  offsetSeconds: number
}

export interface ChunkScheduler {
  /** Schedules one chunk of PCM samples immediately after whatever was
   * scheduled before it (no gap, no overlap). */
  scheduleChunk: (samples: Float32Array, sampleRate: number) => ScheduledChunk
  /** Seconds since the first chunk was scheduled, or -1 before that. */
  getElapsed: () => number
  /** Starts a fresh back-to-back timeline (e.g. a new sentence/turn). */
  reset: () => void
}

// Small look-ahead so the very first chunk doesn't get clipped by scheduling
// it at "now" (the audio graph needs a sliver of lead time to start cleanly).
const DEFAULT_SCHEDULE_LEAD_SECONDS = 0.05

/** Creates a scheduler that plays PCM chunks back-to-back on `destination`
 * (an AnalyserNode, GainNode, or ctx.destination directly) with no audible
 * gaps between chunks, regardless of how their arrival is paced. */
export function createChunkScheduler(
  ctx: AudioContext,
  destination: AudioNode,
  leadSeconds: number = DEFAULT_SCHEDULE_LEAD_SECONDS
): ChunkScheduler {
  let startTime: number | null = null
  let nextStartTime = 0

  return {
    scheduleChunk(samples: Float32Array, sampleRate: number): ScheduledChunk {
      const buffer = ctx.createBuffer(1, samples.length, sampleRate)
      buffer.copyToChannel(samples, 0)
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(destination)

      const now = ctx.currentTime
      if (startTime === null) {
        startTime = now + leadSeconds
        nextStartTime = startTime
      }
      const chunkStart = Math.max(nextStartTime, now)
      source.start(chunkStart)
      const offsetSeconds = chunkStart - startTime
      nextStartTime = chunkStart + buffer.duration
      return { source, offsetSeconds }
    },
    getElapsed(): number {
      return startTime === null ? -1 : ctx.currentTime - startTime
    },
    reset(): void {
      startTime = null
      nextStartTime = 0
    },
  }
}
