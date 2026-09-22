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
  const pendingTextRef = useRef<string[]>([])
  const workerRunningRef = useRef(false)
  const interruptResolverRef = useRef<(() => void) | null>(null)
  const streamAbortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const audio = new Audio()
    audioRef.current = audio
    return () => {
      audio.pause()
      audioRef.current = null
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

  const runQueueWorker = useCallback(async () => {
    if (workerRunningRef.current) return
    workerRunningRef.current = true
    setSpeaking(true)
    while (pendingTextRef.current.length > 0) {
      const text = pendingTextRef.current.shift()!
      const url = await speakText(text)
      const audio = audioRef.current
      if (!url || !audio) continue
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
        audio.play().catch(() => {
          cleanup()
          resolve()
        })
      })
    }
    workerRunningRef.current = false
    setSpeaking(false)
  }, [])

  /** Queues one sentence/utterance to be spoken, in order. */
  const enqueueSpeech = useCallback(
    (text: string) => {
      const clean = stripMarkdownForSpeech(text)
      if (!status?.tts_available || !clean) return
      pendingTextRef.current.push(clean)
      runQueueWorker()
    },
    [status?.tts_available, runQueueWorker]
  )

  const playReply = useCallback((text: string) => enqueueSpeech(text), [enqueueSpeech])

  /** Barge-in: stop whatever Aura is saying/generating, right now. */
  const interrupt = useCallback(() => {
    pendingTextRef.current = []
    streamAbortRef.current?.abort()
    streamAbortRef.current = null
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

      setMessages((m) => [...m, { role: "user", content: text }])
      setSending(true)

      let assistantIndex = -1
      setMessages((m) => {
        assistantIndex = m.length
        return [...m, { role: "assistant", content: "" }]
      })

      let buffer = ""
      let spokenUpTo = 0
      const controller = new AbortController()
      streamAbortRef.current = controller

      await streamChatMessage(
        text,
        sessionId,
        languageRef.current,
        true,
        {
          onSessionId: (id) => {
            setSessionId(id)
            setStoredSession(sessionKey, id)
          },
          onDelta: (delta) => {
            buffer += delta
            setMessages((m) => {
              if (assistantIndex < 0 || assistantIndex >= m.length) return m
              const next = [...m]
              next[assistantIndex] = { role: "assistant", content: buffer }
              return next
            })
            const rest = buffer.slice(spokenUpTo)
            const match = rest.match(SENTENCE_END)
            if (match && match[0].trim()) {
              enqueueSpeech(match[0])
              spokenUpTo += match[0].length
            }
          },
          onSafety: (safety) => {
            setSupportive(true)
            setSafetyBlocks((s) => ({ ...s, [assistantIndex]: safety }))
          },
        },
        controller.signal
      ).catch(() => {
        /* an aborted/dropped stream (e.g. barge-in) is not an error - keep
           whatever text arrived */
      })

      const tail = buffer.slice(spokenUpTo).trim()
      if (tail && streamAbortRef.current === controller) enqueueSpeech(tail)

      if (streamAbortRef.current === controller) streamAbortRef.current = null
      setSending(false)
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
  }
}
