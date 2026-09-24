/**
 * The realtime (full-duplex) voice engine - Gemini Live via
 * /api/realtime-voice/ws, BETA. Deliberately a SEPARATE hook from
 * useAuraConversation.ts, not a modification of it: that hook's
 * STT-then-LLM-then-TTS turn model (batch utterance capture, explicit
 * sendStreaming() calls, client-side barge-in heuristics) doesn't apply
 * here. Gemini's own server-side VAD handles turn-taking and interruption
 * natively - this hook's job is just to keep the mic streaming continuously
 * and play back whatever comes down the wire, staying out of the way.
 *
 * See backend/app/services/gemini_live.py's module docstring for why this
 * is a beta/opt-in surface (free-tier privacy caveat), not the default.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { ChatMessage, SafetyBlock } from "./chatApi"
import { ContinuousMicStream, AudioLevels } from "./continuousMicStream"
import { createChunkScheduler, decodePcm16Bytes } from "./pcmAudioPlayback"
import { WordTiming } from "./streamingSpeech"
import {
  RealtimeVoiceEvent,
  RealtimeVoiceSocket,
  RealtimeVoiceStatus,
  connectRealtimeVoiceSocket,
  fetchRealtimeVoiceStatus,
} from "./realtimeVoiceApi"

const OUTPUT_SAMPLE_RATE = 24000
const LATENCY_LOG = typeof import.meta !== "undefined" && !!import.meta.env?.DEV
function markLatency(label: string, t0: number) {
  if (LATENCY_LOG) console.debug(`[latency:realtime] ${label}: ${(performance.now() - t0).toFixed(0)}ms`)
}

export function useRealtimeVoiceConversation() {
  const [status, setStatus] = useState<RealtimeVoiceStatus | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [safetyBlocks, setSafetyBlocks] = useState<Record<number, SafetyBlock>>({})
  const [connecting, setConnecting] = useState(false)
  const [connected, setConnected] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [micError, setMicError] = useState<string | null>(null)

  const micRef = useRef<ContinuousMicStream | null>(null)
  const socketRef = useRef<RealtimeVoiceSocket | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const schedulerRef = useRef<ReturnType<typeof createChunkScheduler> | null>(null)
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([])
  const currentAssistantIndexRef = useRef(-1)
  const currentTurnIdRef = useRef<string | null>(null)
  const t0Ref = useRef(0)
  const firstAudioLoggedRef = useRef(false)

  // Word-level timing for the CURRENT turn, estimated (not exact - Gemini
  // gives no per-character alignment like ElevenLabs) from REAL audio-
  // scheduling timestamps: each output_transcript_delta is anchored to
  // scheduler.getElapsed() at the moment it arrives, and its words are
  // interpolated proportionally-by-character-count across the span between
  // that anchor and the NEXT delta's anchor (or turn-end). Grounded in
  // actual measured audio duration between deltas, not a fixed fake timer.
  const turnWordsRef = useRef<WordTiming[]>([])
  const pendingDeltaRef = useRef<{ text: string; anchor: number } | null>(null)

  const closePendingDelta = useCallback((endElapsed: number) => {
    const pending = pendingDeltaRef.current
    pendingDeltaRef.current = null
    if (!pending) return
    const span = Math.max(0.05, endElapsed - pending.anchor)
    const textLen = pending.text.length || 1
    const re = /\S+/g
    let m: RegExpExecArray | null
    while ((m = re.exec(pending.text))) {
      const startFrac = m.index / textLen
      const endFrac = (m.index + m[0].length) / textLen
      turnWordsRef.current.push({
        text: m[0],
        start: pending.anchor + startFrac * span,
        end: pending.anchor + endFrac * span,
      })
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    fetchRealtimeVoiceStatus().then((s) => {
      if (!cancelled) setStatus(s)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const getAudioGraph = useCallback(() => {
    if (!audioCtxRef.current) {
      const AudioCtxClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      const ctx = new AudioCtxClass()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      analyser.connect(ctx.destination)
      audioCtxRef.current = ctx
      analyserRef.current = analyser
      schedulerRef.current = createChunkScheduler(ctx, analyser)
    }
    if (audioCtxRef.current.state === "suspended") {
      audioCtxRef.current.resume().catch(() => {})
    }
    return { ctx: audioCtxRef.current, scheduler: schedulerRef.current! }
  }, [])

  const getAmplitude = useCallback((): number => {
    const analyser = analyserRef.current
    if (!analyser) return 0
    const data = new Uint8Array(analyser.fftSize)
    analyser.getByteTimeDomainData(data)
    let sumSquares = 0
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128
      sumSquares += v * v
    }
    return Math.min(1, Math.sqrt(sumSquares / data.length) * 4)
  }, [])

  /** Real (if estimated) word-level timing for the current turn - see
   * turnWordsRef's docstring above for how it's derived. */
  const getSpeechProgress = useCallback((): { words: WordTiming[]; elapsed: number } | null => {
    if (turnWordsRef.current.length === 0) return null
    return { words: turnWordsRef.current, elapsed: schedulerRef.current?.getElapsed() ?? -1 }
  }, [])

  const flushAudio = useCallback(() => {
    for (const s of activeSourcesRef.current) {
      try {
        s.stop()
      } catch {
        /* already ended */
      }
    }
    activeSourcesRef.current = []
    schedulerRef.current?.reset()
    setSpeaking(false)
  }, [])

  const handleAudioChunk = useCallback(
    (pcm: ArrayBuffer) => {
      const { scheduler } = getAudioGraph()
      // Direct decode, no base64 round-trip - these are already raw bytes
      // off the wire and every microsecond here is on the audio-out latency
      // path.
      const samples = decodePcm16Bytes(pcm)
      if (samples.length === 0) return
      if (!firstAudioLoggedRef.current) {
        firstAudioLoggedRef.current = true
        markLatency("first_audio_played", t0Ref.current)
      }
      const { source } = scheduler.scheduleChunk(samples, OUTPUT_SAMPLE_RATE)
      activeSourcesRef.current.push(source)
      setSpeaking(true)
      source.onended = () => {
        activeSourcesRef.current = activeSourcesRef.current.filter((s) => s !== source)
      }
    },
    [getAudioGraph]
  )

  const ensureAssistantMessage = useCallback((turnId: string) => {
    if (currentTurnIdRef.current !== turnId) {
      currentTurnIdRef.current = turnId
      firstAudioLoggedRef.current = false
      // Safe to reset word-timing state here without racing audio arrival:
      // the scheduler's timeline itself is reset when the PREVIOUS turn
      // completed/was interrupted (see those cases below), before this new
      // turn's audio or transcript can arrive - so scheduler.getElapsed()
      // is already "seconds into this turn" by the time either shows up.
      turnWordsRef.current = []
      pendingDeltaRef.current = null
      setMessages((m) => {
        currentAssistantIndexRef.current = m.length
        return [...m, { role: "assistant", content: "" }]
      })
    }
  }, [])

  const handleEvent = useCallback(
    (evt: RealtimeVoiceEvent) => {
      switch (evt.type) {
        case "ready":
          markLatency("ws_ready", t0Ref.current)
          break
        case "unavailable":
          setMicError(
            evt.reason === "not_configured"
              ? "Realtime voice isn't configured on this server."
              : "Realtime voice couldn't start right now."
          )
          break
        case "output_transcript_delta": {
          ensureAssistantMessage(evt.turn_id)
          const anchor = schedulerRef.current?.getElapsed() ?? -1
          const lastWordEnd = turnWordsRef.current[turnWordsRef.current.length - 1]?.end ?? 0
          closePendingDelta(anchor >= 0 ? anchor : lastWordEnd)
          pendingDeltaRef.current = { text: evt.text, anchor: anchor >= 0 ? anchor : lastWordEnd }
          setMessages((m) => {
            const idx = currentAssistantIndexRef.current
            if (idx < 0 || idx >= m.length) return m
            const next = [...m]
            next[idx] = { role: "assistant", content: next[idx].content + evt.text }
            return next
          })
          break
        }
        case "safety": {
          const idx = currentAssistantIndexRef.current
          if (idx >= 0) {
            setSafetyBlocks((s) => ({
              ...s,
              [idx]: {
                triggered: true,
                severity: evt.severity,
                message: evt.message,
                resources: evt.resources,
              },
            }))
          }
          break
        }
        case "interrupted":
          closePendingDelta(schedulerRef.current?.getElapsed() ?? 0)
          flushAudio() // resets the scheduler's timeline too
          currentTurnIdRef.current = null
          break
        case "turn_complete": {
          // closePendingDelta itself floors the span at 0.05s, so no extra
          // fallback arithmetic is needed here even if elapsed is 0.
          closePendingDelta(schedulerRef.current?.getElapsed() ?? pendingDeltaRef.current?.anchor ?? 0)
          schedulerRef.current?.reset()
          currentTurnIdRef.current = null
          break
        }
      }
    },
    [ensureAssistantMessage, flushAudio, closePendingDelta]
  )

  const start = useCallback(
    async (language?: string) => {
      setMicError(null)
      setConnecting(true)
      t0Ref.current = performance.now()
      firstAudioLoggedRef.current = false
      try {
        const mic = new ContinuousMicStream()
        micRef.current = mic
        const socket = connectRealtimeVoiceSocket(null, language, handleEvent, handleAudioChunk)
        socketRef.current = socket

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("connect_timeout")), 15000)
          socket.ws.addEventListener("open", () => {
            clearTimeout(timeout)
            resolve()
          })
          socket.ws.addEventListener("error", () => {
            clearTimeout(timeout)
            reject(new Error("connect_failed"))
          })
        })

        await mic.start((pcm) => socket.sendAudioChunk(pcm))
        setConnected(true)
        markLatency("mic_and_socket_ready", t0Ref.current)
        return true
      } catch (err) {
        const name = (err as Error)?.name
        setMicError(
          name === "NotAllowedError" || name === "PermissionDeniedError"
            ? "Microphone access was blocked. Please allow microphone access for this site and try again."
            : name === "NotFoundError" || name === "DevicesNotFoundError"
            ? "No microphone was found on this device."
            : `Couldn't start realtime voice: ${(err as Error)?.message || "unknown error"}.`
        )
        socketRef.current?.close()
        socketRef.current = null
        micRef.current?.stop()
        micRef.current = null
        return false
      } finally {
        setConnecting(false)
      }
    },
    [handleEvent, handleAudioChunk]
  )

  const stop = useCallback(() => {
    flushAudio()
    socketRef.current?.close()
    socketRef.current = null
    micRef.current?.stop()
    micRef.current = null
    setConnected(false)
    currentTurnIdRef.current = null
  }, [flushAudio])

  /** Local defensive flush only - real interruption is automatic via
   * Gemini's own VAD once the user's continuously-streaming mic picks up
   * their voice again. This just stops anything already scheduled
   * client-side without waiting for the server's `interrupted` event. */
  const interrupt = useCallback(() => {
    flushAudio()
  }, [flushAudio])

  /** Realtime mode has no scripted opener spoken through Gemini (there is
   * no clean way to make Gemini say an exact fixed line without risking
   * paraphrase) - just a plain UI cue in the transcript, never attributed
   * as spoken audio. */
  const greet = useCallback((text: string) => {
    setMessages((m) => [...m, { role: "assistant", content: text }])
  }, [])

  const reset = useCallback(() => {
    stop()
    setMessages([])
    setSafetyBlocks({})
  }, [stop])

  useEffect(() => stop, [stop])

  return {
    status,
    messages,
    safetyBlocks,
    connecting,
    connected,
    speaking,
    micError,
    start,
    stop,
    interrupt,
    reset,
    greet,
    getAmplitude,
    getSpeechProgress,
    getLevels: (): AudioLevels | null => micRef.current?.getLevels() ?? null,
    resumeIfSuspended: () => micRef.current?.resumeIfSuspended(),
  }
}
