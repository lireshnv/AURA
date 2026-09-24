/**
 * The one Aura conversation engine, shared by every surface that talks to
 * the Companion - the text chat page and the voice-first "Speak with Aura"
 * card in Emotion Analysis. Both call this hook rather than each keeping
 * their own copy of the session/safety/TTS logic, so there is exactly one
 * place that owns what "a turn with Aura" means.
 *
 * SESSION CONTINUITY: the session id is kept in sessionStorage (same
 * lifetime as the auth token - cleared when the tab closes, not before), so
 * moving between the text Companion and Speak-with-Aura within one visit
 * continues the same conversation instead of starting over.
 *
 * STREAMING + PROGRESSIVE SPEECH: sendStreaming() consumes the backend's SSE
 * text stream and speaks completed sentences as they arrive (via an ordered
 * TTS queue) rather than waiting for the full reply - Aura's voice starts
 * while the rest of the reply is still generating. interrupt() (barge-in)
 * cancels both the in-flight generation and whatever is queued to speak.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import {
  ChatMessage,
  CompanionStatus,
  SafetyBlock,
  clearConversation,
  fetchCompanionStatus,
  fetchHistory,
  sendChatMessage,
  speakText,
  startNewConversation,
  streamChatMessage,
} from "./chatApi"
import { SpeechStreamController, WordTiming, playSentenceStream } from "./streamingSpeech"

const LATENCY_LOG = typeof import.meta !== "undefined" && !!import.meta.env?.DEV
function markLatency(label: string, t0: number) {
  if (LATENCY_LOG) console.debug(`[latency] ${label}: ${(performance.now() - t0).toFixed(0)}ms`)
}

const DEFAULT_SESSION_STORAGE_KEY = "aura_companion_session_id"

function getStoredSession(key: string): string | null {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}

function setStoredSession(key: string, id: string | null) {
  try {
    if (id) sessionStorage.setItem(key, id)
    else sessionStorage.removeItem(key)
  } catch {
    /* per-browser convenience only - conversation still works without it */
  }
}

/** Strips the light Markdown the model uses (bold/italic/code marks) before
 * handing text to TTS - spoken "asterisk asterisk" is worse than nothing. */
function stripMarkdownForSpeech(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim()
}

// Matches the shortest run of text up to and including a sentence-ending
// punctuation mark followed by whitespace or end-of-string - used to find
// completed sentences inside a still-growing stream buffer.
const SENTENCE_END = /^[\s\S]*?[.!?](?:\s|$)/
// Fast-start rule: only for the very first chunk of a turn, if the model is
// building a long sentence, break at the next clause boundary instead of
// waiting for the full stop - shaves the wait before Aura's voice starts
// without making the rest of the reply sound choppy (later chunks still
// require SENTENCE_END).
const CLAUSE_BREAK = /^[\s\S]*?[,;:—](?:\s|$)/
const FIRST_CHUNK_FAST_START_CHARS = 60

function findSpeakableChunk(rest: string, isFirstChunk: boolean): string | null {
  const sentenceMatch = rest.match(SENTENCE_END)
  if (sentenceMatch && sentenceMatch[0].trim()) return sentenceMatch[0]
  if (isFirstChunk && rest.length >= FIRST_CHUNK_FAST_START_CHARS) {
    const clauseMatch = rest.match(CLAUSE_BREAK)
    if (clauseMatch && clauseMatch[0].trim()) return clauseMatch[0]
  }
  return null
}

/**
 * `sessionKey` lets two independent surfaces (e.g. AI Companion's separate
 * "Chat" and "Talk to Aura" modes) each keep their own session id and
 * history in sessionStorage, rather than sharing the one default key -
 * still the exact same backend endpoint/session store, just two distinct
 * sessions instead of one continued across surfaces.
 */
export function useAuraConversation(language: string, sessionKey: string = DEFAULT_SESSION_STORAGE_KEY) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [safetyBlocks, setSafetyBlocks] = useState<Record<number, SafetyBlock>>({})
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [supportive, setSupportive] = useState(false)
  const [status, setStatus] = useState<CompanionStatus | null>(null)
  const [ready, setReady] = useState(false)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const languageRef = useRef(language)
  useEffect(() => {
    languageRef.current = language
  }, [language])

  // --- Ordered speech queue: sentences are spoken strictly in the order
  //     they were enqueued, regardless of how long each TTS fetch takes. ---
  const pendingTextRef = useRef<{ text: string; turnId: number }[]>([])
  const workerRunningRef = useRef(false)
  const interruptResolverRef = useRef<(() => void) | null>(null)
  const streamAbortRef = useRef<AbortController | null>(null)
  const speechAbortRef = useRef<AbortController | null>(null)
  const currentSpeechRef = useRef<SpeechStreamController | null>(null)

  // Monotonic turn id: every user-triggered turn (typed or spoken) bumps
  // this, and every async continuation (a streamed delta, a queued sentence,
  // a playing audio chunk) checks it before touching state/audio. interrupt()
  // bumps it immediately, so nothing from a turn the user has since
  // interrupted can ever surface - no stale text, no stale audio, no race
  // between an old and a new turn's callbacks.
  const turnIdRef = useRef(0)

  // Lazily-created Web Audio graph the streaming TTS player schedules PCM
  // chunks onto. Kept behind an AnalyserNode (not straight to destination)
  // so real playback amplitude is available for audio-reactive UI, same
  // math as useAudioAmplitude.ts, without needing an <audio> element at all
  // for the streamed path.
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)

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
    }
    if (audioCtxRef.current.state === "suspended") {
      audioCtxRef.current.resume().catch(() => {})
    }
    return { audioCtx: audioCtxRef.current, destination: analyserRef.current! }
  }, [])

  /** Current playback amplitude (0-1) of streamed TTS audio, for
   * audio-reactive UI (lip-sync). Poll it; it doesn't trigger re-renders. */
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

  /** Current sentence's word timings + playback position, for real
   * word-level highlight sync. Null when nothing is streaming right now. */
  const getSpeechProgress = useCallback((): { words: WordTiming[]; elapsed: number } | null => {
    const speech = currentSpeechRef.current
    if (!speech) return null
    return { words: speech.getWords(), elapsed: speech.getElapsed() }
  }, [])

  useEffect(() => {
    const audio = new Audio()
    audioRef.current = audio
    return () => {
      audio.pause()
      audioRef.current = null
      audioCtxRef.current?.close().catch(() => {})
      audioCtxRef.current = null
      analyserRef.current = null
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    fetchCompanionStatus().then((s) => {
      if (!cancelled) setStatus(s)
    })
    ;(async () => {
      const existing = getStoredSession(sessionKey)
      if (existing) {
        const history = await fetchHistory(existing)
        if (cancelled) return
        setSessionId(existing)
        setMessages(history)
        setReady(true)
        return
      }
      const fresh = await startNewConversation()
      if (cancelled) return
      setSessionId(fresh)
      setStoredSession(sessionKey, fresh)
      setReady(true)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Plays one sentence via the batch (non-streaming) TTS endpoint - the
   * fallback path when streaming TTS produced no audio at all. */
  const playBatchFallback = useCallback(async (text: string, turnId: number) => {
    const url = await speakText(text)
    const audio = audioRef.current
    if (!url || !audio || turnId !== turnIdRef.current) return
    await new Promise<void>((resolve) => {
      interruptResolverRef.current = resolve
      const cleanup = () => {
        audio.removeEventListener("ended", onEnd)
        audio.removeEventListener("error", onEnd)
        interruptResolverRef.current = null
      }
      const onEnd = () => {
        cleanup()
        resolve()
      }
      audio.addEventListener("ended", onEnd)
      audio.addEventListener("error", onEnd)
      audio.src = url
      audio.play().catch((err) => {
        if (LATENCY_LOG) console.warn("[voice] audio.play() was blocked:", err)
        cleanup()
        resolve()
      })
    })
  }, [])

  // Streaming TTS (ElevenLabs) is attempted once; if it produces no audio at
  // all (unconfigured account, plan restriction, network failure), further
  // sentences THIS SESSION go straight to the batch fallback instead of
  // paying for a doomed extra round trip on every single sentence - that
  // wasted attempt was adding a full network round trip of latency (and, on
  // slow connections, could push audio.play() past the browser's autoplay
  // grace window) to every reply for an account where streaming can never
  // succeed. Reset to "try again" on reset()/a fresh mount.
  const streamingTtsBrokenRef = useRef(false)

  const runQueueWorker = useCallback(async () => {
    if (workerRunningRef.current) return
    workerRunningRef.current = true
    setSpeaking(true)
    while (pendingTextRef.current.length > 0) {
      const item = pendingTextRef.current.shift()!
      if (item.turnId !== turnIdRef.current) continue // interrupted since it was queued

      let receivedAudio = false
      if (!streamingTtsBrokenRef.current) {
        try {
          const { audioCtx, destination } = getAudioGraph()
          const controller = new AbortController()
          speechAbortRef.current = controller
          const speech = playSentenceStream(audioCtx, destination, item.text, controller.signal)
          currentSpeechRef.current = speech

          await speech.done
          if (currentSpeechRef.current === speech) currentSpeechRef.current = null
          receivedAudio = speech.receivedAudio()
          if (!receivedAudio) streamingTtsBrokenRef.current = true
        } catch (err) {
          // Web Audio unsupported/unavailable in this browser - fall through
          // to the <audio>-element batch path below rather than wedging the
          // queue worker forever.
          streamingTtsBrokenRef.current = true
          if (LATENCY_LOG) console.warn("[voice] streaming TTS failed, falling back:", err)
        }
      }

      if (!receivedAudio && item.turnId === turnIdRef.current) {
        // Streaming TTS produced nothing (ElevenLabs unavailable/failed, or
        // Web Audio itself threw) - the reply still gets spoken, just
        // without progressive playback.
        await playBatchFallback(item.text, item.turnId)
      }
    }
    workerRunningRef.current = false
    setSpeaking(false)
  }, [getAudioGraph, playBatchFallback])

  /** Queues one sentence/utterance to be spoken, in order, tagged to the
   * turn that produced it so a later interrupt() can drop it if it hasn't
   * played yet. */
  const enqueueSpeech = useCallback(
    (text: string, turnId: number) => {
      const clean = stripMarkdownForSpeech(text)
      if (!status?.tts_available || !clean) return
      pendingTextRef.current.push({ text: clean, turnId })
      runQueueWorker()
    },
    [status?.tts_available, runQueueWorker]
  )

  const playReply = useCallback(
    (text: string) => enqueueSpeech(text, ++turnIdRef.current),
    [enqueueSpeech]
  )

  /** Barge-in: stop whatever Aura is saying/generating, right now. Bumping
   * turnIdRef first means every in-flight callback from the interrupted
   * turn (a streamed delta, a queued-but-not-yet-played sentence, an
   * in-progress audio schedule) becomes a no-op the instant it next checks. */
  const interrupt = useCallback(() => {
    turnIdRef.current += 1
    pendingTextRef.current = []
    streamAbortRef.current?.abort()
    streamAbortRef.current = null
    speechAbortRef.current?.abort()
    speechAbortRef.current = null
    currentSpeechRef.current?.stop()
    currentSpeechRef.current = null
    audioRef.current?.pause()
    interruptResolverRef.current?.()
    interruptResolverRef.current = null
    setSpeaking(false)
    setSending(false)
  }, [])

  const stopSpeaking = interrupt

  const send = useCallback(
    async (text: string, speak: boolean = true) => {
      if (!text.trim() || sending) return

      setMessages((m) => [...m, { role: "user", content: text }])
      setSending(true)

      const reply = await sendChatMessage(text, sessionId, language)
      if (reply.session_id) {
        setSessionId(reply.session_id)
        setStoredSession(sessionKey, reply.session_id)
      }

      setSupportive(!!reply.safety?.triggered)
      setMessages((m) => {
        const next = [...m, { role: "assistant" as const, content: reply.response }]
        if (reply.safety?.triggered) {
          setSafetyBlocks((s) => ({ ...s, [next.length - 1]: reply.safety! }))
        }
        return next
      })
      setSending(false)
      if (speak && reply.status === "success") playReply(reply.response)
      return reply
    },
    [sending, sessionId, playReply, language, sessionKey]
  )

  /**
   * The voice-conversation path: streams Aura's reply and speaks completed
   * sentences as they're detected, instead of waiting for the whole thing.
   */
  const sendStreaming = useCallback(
    async (text: string) => {
      if (!text.trim() || sending) return

      const myTurn = ++turnIdRef.current
      const t0 = performance.now()

      setMessages((m) => [...m, { role: "user", content: text }])
      setSending(true)

      let assistantIndex = -1
      setMessages((m) => {
        assistantIndex = m.length
        return [...m, { role: "assistant", content: "" }]
      })

      let buffer = ""
      let spokenUpTo = 0
      let firstDeltaSeen = false
      let firstChunkEnqueued = false
      const controller = new AbortController()
      streamAbortRef.current = controller

      await streamChatMessage(
        text,
        sessionId,
        languageRef.current,
        true,
        {
          onSessionId: (id) => {
            if (myTurn !== turnIdRef.current) return
            setSessionId(id)
            setStoredSession(sessionKey, id)
          },
          onDelta: (delta) => {
            if (myTurn !== turnIdRef.current) return
            if (!firstDeltaSeen) {
              firstDeltaSeen = true
              markLatency("first_llm_delta", t0)
            }
            buffer += delta
            setMessages((m) => {
              if (assistantIndex < 0 || assistantIndex >= m.length) return m
              const next = [...m]
              next[assistantIndex] = { role: "assistant", content: buffer }
              return next
            })
            const rest = buffer.slice(spokenUpTo)
            const chunk = findSpeakableChunk(rest, spokenUpTo === 0)
            if (chunk) {
              if (!firstChunkEnqueued) {
                firstChunkEnqueued = true
                markLatency("first_speech_chunk_enqueued", t0)
              }
              enqueueSpeech(chunk, myTurn)
              spokenUpTo += chunk.length
            }
          },
          onSafety: (safety) => {
            if (myTurn !== turnIdRef.current) return
            setSupportive(true)
            setSafetyBlocks((s) => ({ ...s, [assistantIndex]: safety }))
          },
        },
        controller.signal,
        String(myTurn)
      ).catch(() => {
        /* an aborted/dropped stream (e.g. barge-in) is not an error - keep
           whatever text arrived */
      })

      if (myTurn === turnIdRef.current) {
        const tail = buffer.slice(spokenUpTo).trim()
        if (tail) enqueueSpeech(tail, myTurn)
        if (streamAbortRef.current === controller) streamAbortRef.current = null
        setSending(false)
      }
    },
    [sending, sessionId, enqueueSpeech, sessionKey]
  )

  /**
   * A scripted opener/acknowledgement, spoken through the same TTS engine as
   * a real reply. Deliberately NOT a call to the LLM - it's fixed UI copy
   * ("I'm here, what's on your mind?"), not a fabricated model response, so
   * it never enters the persisted session history the same way a real turn
   * does. Used to make voice-first surfaces feel immediately alive instead
   * of sitting silently until the user speaks first.
   */
  const greet = useCallback(
    (text: string) => {
      setMessages((m) => [...m, { role: "assistant", content: text }])
      playReply(text)
    },
    [playReply]
  )

  const reset = useCallback(async () => {
    interrupt()
    streamingTtsBrokenRef.current = false
    if (sessionId) await clearConversation(sessionId)
    const fresh = await startNewConversation()
    setSessionId(fresh)
    setStoredSession(sessionKey, fresh)
    setMessages([])
    setSafetyBlocks({})
    setSupportive(false)
  }, [sessionId, interrupt, sessionKey])

  return {
    messages,
    safetyBlocks,
    sessionId,
    sending,
    speaking,
    supportive,
    status,
    ready,
    send,
    sendStreaming,
    interrupt,
    reset,
    stopSpeaking,
    greet,
    /** Real word-level timing for the sentence currently playing (from
     * ElevenLabs' streamed alignment), for text-highlight sync. */
    getSpeechProgress,
    /** Real playback amplitude (0-1) of the currently-streaming TTS audio,
     * for audio-reactive UI. */
    getAmplitude,
  }
}
