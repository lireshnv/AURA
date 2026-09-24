/**
 * Progressive TTS playback for one sentence: schedules raw 16kHz PCM chunks
 * on a Web Audio graph back-to-back as they arrive from
 * POST /api/chat/speak/stream, instead of waiting for a full audio file.
 *
 * Also derives real word-level timing from each chunk's ElevenLabs
 * `alignment` (per-character timestamps), rather than faking sync with a
 * fixed timer - useAuraConversation exposes this so the UI can highlight
 * the word Aura is actually saying at that instant.
 */
import { SpeechChunk, streamSpeech } from "./chatApi"
import { ChunkScheduler, createChunkScheduler, decodePcm16 } from "./pcmAudioPlayback"

const PCM_SAMPLE_RATE = 16000

export interface WordTiming {
  text: string
  /** Seconds from the start of THIS sentence's audio. */
  start: number
  end: number
}

export interface SpeechStreamController {
  /** Stops playback and any further scheduling immediately (barge-in). */
  stop: () => void
  /** Resolves once playback has finished naturally, or stop() was called. */
  done: Promise<void>
  /** Whether at least one audio chunk actually arrived and was scheduled. */
  receivedAudio: () => boolean
  getWords: () => WordTiming[]
  /** Seconds elapsed since this sentence started playing, or -1 before the
   * first chunk has been scheduled. */
  getElapsed: () => number
}

/** Rebuilds a word list from whatever characters/timings have streamed in so
 * far - cheap to recompute from scratch each chunk since sentences are short. */
function wordsFromCharTimings(charTimings: { ch: string; t: number }[]): WordTiming[] {
  const text = charTimings.map((c) => c.ch).join("")
  const words: WordTiming[] = []
  const re = /\S+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const startIdx = m.index
    const endIdx = m.index + m[0].length - 1
    words.push({ text: m[0], start: charTimings[startIdx].t, end: charTimings[endIdx].t })
  }
  return words
}

/**
 * Starts streaming + scheduling TTS for `text` on the given AudioContext,
 * routed through `destination` (so the caller can fan playback into an
 * analyser for amplitude/lip-sync without this module knowing about that).
 */
export function playSentenceStream(
  ctx: AudioContext,
  destination: AudioNode,
  text: string,
  signal: AbortSignal
): SpeechStreamController {
  let stopped = false
  let charTimings: { ch: string; t: number }[] = []
  let words: WordTiming[] = []
  let receivedAudio = false
  const sources: AudioBufferSourceNode[] = []
  const scheduler: ChunkScheduler = createChunkScheduler(ctx, destination)

  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    resolveDone()
  }

  const handleChunk = (chunk: SpeechChunk) => {
    if (stopped || signal.aborted) return
    const samples = decodePcm16(chunk.audio_base64)
    if (samples.length === 0) return

    let scheduled: ReturnType<ChunkScheduler["scheduleChunk"]>
    try {
      scheduled = scheduler.scheduleChunk(samples, PCM_SAMPLE_RATE)
    } catch {
      return
    }
    sources.push(scheduled.source)
    receivedAudio = true

    const alignment = chunk.alignment ?? chunk.normalized_alignment
    if (alignment?.characters?.length) {
      const relOffset = scheduled.offsetSeconds
      const starts = alignment.character_start_times_seconds || []
      for (let i = 0; i < alignment.characters.length; i++) {
        charTimings.push({ ch: alignment.characters[i], t: relOffset + (starts[i] ?? 0) })
      }
      words = wordsFromCharTimings(charTimings)
    }
  }

  ;(async () => {
    try {
      await streamSpeech(text, { onChunk: handleChunk }, signal)
    } catch {
      /* handled below via receivedAudio */
    }
    if (stopped) return
    if (!receivedAudio) {
      finish()
      return
    }
    const lastSource = sources[sources.length - 1]
    if (lastSource) {
      await new Promise<void>((resolve) => {
        lastSource.onended = () => resolve()
      })
    }
    finish()
  })()

  return {
    stop: () => {
      if (stopped) return
      stopped = true
      for (const s of sources) {
        try {
          s.stop()
        } catch {
          /* already stopped/ended */
        }
      }
      finish()
    },
    done,
    receivedAudio: () => receivedAudio,
    getWords: () => words,
    getElapsed: () => scheduler.getElapsed(),
  }
}
