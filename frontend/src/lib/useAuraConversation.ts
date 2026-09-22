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
} from "./chatApi"

const SESSION_STORAGE_KEY = "aura_companion_session_id"

function getStoredSession(): string | null {
  try {
    return sessionStorage.getItem(SESSION_STORAGE_KEY)
  } catch {
    return null
  }
}

function setStoredSession(id: string | null) {
  try {
    if (id) sessionStorage.setItem(SESSION_STORAGE_KEY, id)
    else sessionStorage.removeItem(SESSION_STORAGE_KEY)
  } catch {
    /* per-browser convenience only - conversation still works without it */
  }
}

export function useAuraConversation(language: string) {
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

  useEffect(() => {
    const audio = new Audio()
    audio.addEventListener("play", () => setSpeaking(true))
    audio.addEventListener("ended", () => setSpeaking(false))
    audio.addEventListener("pause", () => setSpeaking(false))
    audio.addEventListener("error", () => setSpeaking(false))
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
      const existing = getStoredSession()
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
      setStoredSession(fresh)
      setReady(true)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const playReply = useCallback(
    async (text: string) => {
      if (!status?.tts_available || !audioRef.current) return
      const url = await speakText(text)
      if (!url) return
      audioRef.current.src = url
      try {
        await audioRef.current.play()
      } catch {
        /* autoplay blocked or playback failed - the text reply already shown */
      }
    },
    [status?.tts_available]
  )

  const send = useCallback(
    async (text: string) => {
      if (!text.trim() || sending) return

      setMessages((m) => [...m, { role: "user", content: text }])
      setSending(true)

      const reply = await sendChatMessage(text, sessionId, language)
      if (reply.session_id) {
        setSessionId(reply.session_id)
        setStoredSession(reply.session_id)
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
      if (reply.status === "success") playReply(reply.response)
      return reply
    },
    [sending, sessionId, playReply, language]
  )

  const stopSpeaking = useCallback(() => {
    audioRef.current?.pause()
  }, [])

  const reset = useCallback(async () => {
    if (sessionId) await clearConversation(sessionId)
    const fresh = await startNewConversation()
    setSessionId(fresh)
    setStoredSession(fresh)
    setMessages([])
    setSafetyBlocks({})
    setSupportive(false)
  }, [sessionId])

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
    reset,
    stopSpeaking,
  }
}
