import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { WifiOff } from "lucide-react"
import { v4 as uuidv4 } from "uuid"
import LiveEmotionCamera from "./components/LiveEmotionCamera"
import EmotionTimeline from "./components/EmotionTimeline"
import AnalysisControls from "./components/AnalysisControls"
import SessionReportView from "./components/SessionReportView"
import VoiceAnalysis from "./components/VoiceAnalysis"
import LiveTranscript from "./components/LiveTranscript"
import MultimodalTimeline from "./components/MultimodalTimeline"
import AppShell, { Page, Role } from "./components/AppShell"
import HistoryProfilePage from "./components/HistoryProfilePage"
import CounsellorDashboard, { resetSyntheticDataSeed } from "./components/CounsellorDashboard"
import VictimHome from "./components/VictimHome"
import WellbeingRiskPage from "./components/WellbeingRiskPage"
import CheckIn from "./components/CheckIn"
import Support from "./components/Support"
import SafetyPlan from "./components/SafetyPlan"
import HistoryPage from "./components/HistoryPage"
import ProfilePage from "./components/ProfilePage"
import AICompanion from "./components/AICompanion"
import AuraVoiceConversation from "./components/AuraVoiceConversation"
import MyPatterns from "./components/MyPatterns"
import IvrsCallPortal from "./components/IvrsCall/IvrsCallPortal"
import AdminDashboard from "./components/AdminDashboard"
import CounsellorCallPanel from "./components/CounsellorCallPanel"
import GuardianDashboard from "./components/GuardianDashboard"
import PortalSelector from "./components/Auth/PortalSelector"
import AuthScreen from "./components/Auth/AuthScreen"
import OnboardingSurvey from "./components/Auth/OnboardingSurvey"
import { AuthUser, fetchMe, logout as authLogout, Role as AuthRole } from "./lib/authApi"
import { ingestSignals } from "./lib/twinApi"
import {
  AnalyzeResponse,
  AuraAnalysis,
  CameraState,
  DebugMetrics,
  DistressSignalResponse,
  GroqTranscriptAnalysis,
  MultimodalResponse,
  MultimodalTimelinePoint,
  Observation,
  PerformanceMode,
  PipelineStatus,
  SessionReport,
  TextEmotionInfo,
  VoiceCapabilities,
  VoiceFrame,
  VoiceObservation,
} from "./types"
import {
  analyseSession,
  analyzeTranscriptWithGroq,
  API_BASE_URL,
  checkBackendHealth,
  fetchDistressSignal,
  fetchVoiceCapabilities,
  fuseModalities,
  saveHistorySession,
  submitSessionReport,
} from "./lib/api"
import { computeLiveDistress } from "./lib/liveMetrics"

const MAX_OBSERVATIONS = 3600 // 1 hour at ~1s cadence
const LIVE_WINDOW_MS = 15000 // rolling window for live distress/stability estimates
const MIN_OBSERVATIONS_FOR_REPORT = 15
const MAX_VOICE_OBSERVATIONS = 1200
const MAX_TIMELINE_POINTS = 240
const MAX_TRANSCRIPT_LINES = 6
const LANGUAGES = ["auto", "en", "hi", "ta", "te", "ml", "kn"]

const INITIAL_METRICS: DebugMetrics = {
  cameraActive: false,
  backendConnected: false,
  videoWidth: 0,
  videoHeight: 0,
  lastFrameSizeKb: 0,
  apiStatus: "unknown",
  lastResponseMs: null,
  lastAnalysisAt: null,
  faceDetected: false,
  analysisCount: 0,
  skippedCount: 0,
  lastError: null,
  latest: null,
}

export default function App() {
  const sessionIdRef = useRef(uuidv4())
  const [active, setActive] = useState(false)
  const [mode, setMode] = useState<PerformanceMode>("fast")
  const [cameraState, setCameraState] = useState<CameraState>("off")
  const [fatalError, setFatalError] = useState<string | null>(null)
  const [latest, setLatest] = useState<AnalyzeResponse | null>(null)
  const [observations, setObservations] = useState<Observation[]>([])
  const [groqInsight, setGroqInsight] = useState<GroqTranscriptAnalysis | null>(null)
  const [sessionStart, setSessionStart] = useState<number | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null)
  const [metrics, setMetrics] = useState<DebugMetrics>(INITIAL_METRICS)
  const [report, setReport] = useState<SessionReport | null>(null)
  const [reportLoading, setReportLoading] = useState(false)

  // --- Voice state. Independent of the facial state above: the camera
  //     pipeline never reads any of this, so voice can be off or unavailable
  //     without affecting facial analysis at all. ---
  const [voiceActive, setVoiceActive] = useState(false)
  const [voiceCaps, setVoiceCaps] = useState<VoiceCapabilities | null>(null)
  const [language, setLanguage] = useState("auto")
  const [latestFrame, setLatestFrame] = useState<VoiceFrame | null>(null)
  const [transcriptLines, setTranscriptLines] = useState<string[]>([])
  const [livePartialTranscript, setLivePartialTranscript] = useState("")
  const [voiceObservations, setVoiceObservations] = useState<VoiceObservation[]>([])
  const [fusion, setFusion] = useState<MultimodalResponse | null>(null)
  const [timeline, setTimeline] = useState<MultimodalTimelinePoint[]>([])
  const [agreementSamples, setAgreementSamples] = useState<number[]>([])
  const [auraResult, setAuraResult] = useState<AuraAnalysis | null>(null)
  const [starting, setStarting] = useState(false)
  const [page, setPage] = useState<Page>("home")
  const [distressSignal, setDistressSignal] = useState<DistressSignalResponse | null>(null)

  // Real auth state. No role toggle and no hardcoded identity - who you are
  // and what you can see comes entirely from the authenticated JWT.
  const [authUser, setAuthUser] = useState<AuthUser | null>(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [portalRole, setPortalRole] = useState<AuthRole | null>(null)
  const [googleAuthError, setGoogleAuthError] = useState(false)
  const [resetToken, setResetToken] = useState<string | null>(null)

  useEffect(() => {
    // After a Google sign-in redirect, the browser lands back here with
    // ?auth=google (cookie already set - fetchMe() below picks it up) or
    // ?auth_error=google (shown once, then the URL is cleaned either way).
    // A forgot-password link lands here with ?reset_token=... instead.
    const params = new URLSearchParams(window.location.search)
    if (params.has("auth_error")) setGoogleAuthError(true)
    const token = params.get("reset_token")
    if (token) {
      setResetToken(token)
      setPortalRole("victim")
    }
    if (params.has("auth") || params.has("auth_error") || token) {
      window.history.replaceState({}, "", window.location.pathname)
    }

    fetchMe().then((u) => {
      setAuthUser(u)
      setAuthChecked(true)
    })
  }, [])

  const role = (authUser?.role ?? "victim") as Role
  const activeProfile = authUser?.aura_id ?? ""

  const handleLogout = async () => {
    await authLogout()
    setAuthUser(null)
    setPortalRole(null)
    setPage("home")
  }

  // Latest per-modality readings, kept in refs so the fusion effect can read
  // them without re-subscribing on every frame.
  const faceRef = useRef<AnalyzeResponse | null>(null)
  const frameRef = useRef<VoiceFrame | null>(null)
  const fusingRef = useRef(false)
  const observationsRef = useRef<Observation[]>([])

  /**
   * Trend over the recent window: is the currently-dominant emotion's signal
   * rising or falling? Split-half comparison of the same emotion's score, so
   * it describes a measured change rather than asserting a cause.
   */
  const computeTrendRef = useRef(() => {
    const obs = observationsRef.current
    if (obs.length < 6) return null

    const window = obs.slice(-20)
    const last = window[window.length - 1].emotion_scores
    const dominant = (Object.keys(last) as (keyof typeof last)[]).reduce((best, k) =>
      last[k] > last[best] ? k : best
    )

    const mid = Math.floor(window.length / 2)
    const mean = (slice: Observation[]) =>
      slice.reduce((sum, o) => sum + (o.emotion_scores[dominant] ?? 0), 0) / (slice.length || 1)

    const delta = mean(window.slice(mid)) - mean(window.slice(0, mid))
    const direction = delta > 8 ? "increasing" : delta < -8 ? "decreasing" : "stable"
    return { direction, emotion: String(dominant), delta: Math.round(delta * 10) / 10 }
  })

  const transcriptLinesRef = useRef<string[]>([])

  useEffect(() => {
    observationsRef.current = observations
  }, [observations])

  useEffect(() => {
    transcriptLinesRef.current = transcriptLines
  }, [transcriptLines])

  useEffect(() => {
    let cancelled = false
    const check = async () => {
      const ok = await checkBackendHealth()
      if (!cancelled) {
        setBackendOnline(ok)
        setMetrics((prev) => ({ ...prev, backendConnected: ok }))
      }
    }
    check()
    const id = window.setInterval(check, 15000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

  useEffect(() => {
    fetchVoiceCapabilities().then(setVoiceCaps)
  }, [])

  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => {
      if (sessionStart) setElapsed((Date.now() - sessionStart) / 1000)
    }, 1000)
    return () => window.clearInterval(id)
  }, [active, sessionStart])

  const handleMetrics = useCallback((patch: Partial<DebugMetrics>) => {
    setMetrics((prev) => ({ ...prev, ...patch }))
  }, [])

  /**
   * Consumes one real-time voice frame.
   *
   * Only FINAL frames become session history. Partial frames exist to make the
   * panel feel live; recording them would enter the same speech into the
   * statistics several times, because each partial window overlaps the last.
   */
  const handleVoiceFrame = useCallback((frame: VoiceFrame) => {
    setLatestFrame(frame)
    frameRef.current = frame

    if (!frame.analysis_used) return

    const transcript = frame.transcript?.text ?? ""

    // In-progress text from the fast partial pass, shown live so the panel
    // never looks frozen while someone is still speaking - it is cleared the
    // moment a final pass supersedes it with settled text below.
    if (!frame.transcript?.is_final) {
      setLivePartialTranscript(frame.transcript?.display_text || transcript || "")
    } else {
      setLivePartialTranscript("")
    }

    if (frame.transcript?.is_final && transcript) {
      setTranscriptLines((prev) => {
        if (prev[prev.length - 1] === transcript) return prev
        const next = [...prev, transcript]
        return next.length > MAX_TRANSCRIPT_LINES ? next.slice(-MAX_TRANSCRIPT_LINES) : next
      })

      // Groq only ever sees this SETTLED transcript segment, never a partial
      // in-progress guess - the qualitative layer (concerns/themes/support)
      // on top of the local models' numeric sentiment/emotion above.
      analyzeTranscriptWithGroq(transcript, sessionIdRef.current).then((analysis) => {
        if (analysis.available) setGroqInsight(analysis)
      })
    }

    if (!frame.transcript?.is_final) return

    const signal = frame.voice_signal
    const text = frame.text_emotion?.available ? frame.text_emotion : null
    const hasVoiceLabel = !!signal?.emotion && signal.emotion_confidence !== null

    if (hasVoiceLabel || text) {
      setVoiceObservations((prev) => {
        const obs: VoiceObservation = {
          timestamp: frame.window.timestamp,
          voice_scores: hasVoiceLabel ? signal!.emotion_scores : null,
          voice_confidence: signal?.emotion_confidence ?? 0,
          text_scores: text?.scores ?? null,
          text_confidence: text?.confidence ?? 0,
          transcript: transcript || null,
          audio_quality: frame.quality?.audio_score ?? 0,
          // Derived from the observed acoustic signal rather than a separate
          // stress model: the observation is already the multi-feature read.
          voice_stress:
            signal && signal.observed.startsWith("Elevated")
              ? signal.confidence / 100
              : 0,
        }
        const next = [...prev, obs]
        return next.length > MAX_VOICE_OBSERVATIONS
          ? next.slice(-MAX_VOICE_OBSERVATIONS)
          : next
      })
    }
  }, [])

  // --- Multimodal fusion loop -------------------------------------------
  // Runs on its own cadence, fusing whatever the latest readings are. Skips a
  // tick if the previous fusion is still in flight, and never fabricates a
  // modality that isn't currently producing data.
  useEffect(() => {
    if (!active && !voiceActive) {
      setFusion(null)
      return
    }

    const tick = async () => {
      if (fusingRef.current) return

      const faceResult = faceRef.current
      const voiceResult = frameRef.current

      const facePayload =
        active && faceResult?.analysis_used && faceResult.emotion && faceResult.quality
          ? {
              scores: faceResult.emotion.scores,
              confidence: faceResult.emotion.confidence,
              quality: faceResult.quality.overall,
            }
          : null

      // A voice label only reaches fusion when the pipeline actually named
      // one. A withheld label is an absence of evidence, not a neutral vote.
      const signal = voiceActive && voiceResult?.analysis_used ? voiceResult.voice_signal : null
      const voicePayload =
        signal?.emotion && signal.emotion_confidence !== null
          ? {
              scores: signal.emotion_scores,
              confidence: signal.emotion_confidence,
              quality: voiceResult?.quality?.audio_score ?? 0,
            }
          : null

      const textInfo =
        voiceActive && voiceResult?.analysis_used && voiceResult.text_emotion?.available
          ? voiceResult.text_emotion
          : null
      const textPayload =
        textInfo && textInfo.scores
          ? {
              scores: textInfo.scores,
              confidence: textInfo.confidence ?? 0,
              // Transcript adequacy stands in for "text signal quality": a
              // longer transcript is a firmer basis than a two-word fragment.
              quality: Math.min(
                100,
                ((voiceResult?.transcript?.word_count ?? 0) / 12) * 100
              ),
            }
          : null

      if (!facePayload && !voicePayload && !textPayload) {
        setFusion(null)
        return
      }

      fusingRef.current = true
      try {
        const result = await fuseModalities(facePayload, voicePayload, textPayload)
        if (!result.success) return
        setFusion(result)
        setAgreementSamples((prev) => [...prev.slice(-499), result.agreement.score])

        // One-click explainable result. Reuses the same payloads so the
        // dominant emotion shown here can never diverge from the fusion above.
        // Feed the structured result to the Digital Twin. Fire-and-forget and
        // consent-gated server-side: the analysis pipeline is unchanged and
        // continues identically whether or not this is stored.
        ingestSignals({
          emotion_dominant: result.emotion.dominant,
          emotion_confidence: result.emotion.confidence,
          emotion_scores: result.emotion.scores,
          sentiment_dominant: result.sentiment.dominant,
          sentiment_scores: result.sentiment.scores,
          voice_available: !!voicePayload,
          text_available: !!textPayload,
          modalities: result.modalities_used,
          reliability: result.emotion.reliability,
          session_id: sessionIdRef.current,
        }).catch(() => {
          /* twin storage is optional; never disturb analysis */
        })

        analyseSession({
          face: facePayload,
          voice: voicePayload,
          text: textPayload,
          face_detail: facePayload
            ? {
                dominant: faceResult!.emotion!.dominant,
                confidence: faceResult!.emotion!.confidence,
                quality: faceResult!.quality!.overall,
                signals: faceResult!.debug?.signals ?? {},
                motion: faceResult!.debug?.region_motion ?? {},
                blink: faceResult!.debug?.eyes ?? {},
              }
            : null,
          voice_detail: signal?.emotion
            ? {
                available: true,
                dominant: signal.emotion,
                confidence: signal.emotion_confidence ?? 0,
                // The multi-feature acoustic observation, carried alongside
                // the label so the explanation can cite what was measured
                // rather than only what was inferred.
                stress: {
                  observed: signal.observed,
                  confidence: signal.confidence,
                  contributing_features: signal.contributing_features,
                },
              }
            : { available: false },
          text_detail: textInfo
            ? {
                available: true,
                dominant: textInfo.dominant,
                confidence: textInfo.confidence,
                sentiment: textInfo.sentiment,
              }
            : { available: false },
          trend: computeTrendRef.current(),
        })
          .then((r) => {
            if (r.success) setAuraResult(r)
          })
          .catch(() => {
            /* transient; next tick retries */
          })

        setTimeline((prev) => {
          const point: MultimodalTimelinePoint = {
            timestamp: Date.now(),
            face: facePayload ? faceResult!.emotion!.dominant : null,
            voice: voicePayload ? signal!.emotion : null,
            text: textPayload ? textInfo!.dominant ?? null : null,
            overall: result.emotion.dominant,
            agreement: result.agreement.score,
          }
          const next = [...prev, point]
          return next.length > MAX_TIMELINE_POINTS
            ? next.slice(-MAX_TIMELINE_POINTS)
            : next
        })
      } catch {
        // Transient fusion failure is non-fatal; the next tick retries.
      } finally {
        fusingRef.current = false
      }
    }

    const id = window.setInterval(tick, 1500)
    tick()
    return () => window.clearInterval(id)
  }, [active, voiceActive])

  /**
   * Clears the LIVE readings - the values that describe "right now".
   *
   * Called when a session stops, because a reading from a camera that is no
   * longer running is not a current result. Leaving these populated is what
   * made the page keep showing e.g. "Neutral 77%" long after analysis ended,
   * which reads as a live measurement when nothing is being measured.
   *
   * Session HISTORY (observations, transcript, timeline) is deliberately kept
   * so a report can still be generated after stopping.
   */
  const clearLiveReadings = () => {
    setLatest(null)
    setLatestFrame(null)
    setFusion(null)
    setAuraResult(null)
    setDistressSignal(null)
    faceRef.current = null
    frameRef.current = null
  }

  /** Clears every per-session series so a new run never inherits old data. */
  const resetSessionState = () => {
    sessionIdRef.current = uuidv4()
    setObservations([])
    setGroqInsight(null)
    setVoiceObservations([])
    setTranscriptLines([])
    setLivePartialTranscript("")
    setTimeline([])
    setAgreementSamples([])
    clearLiveReadings()
    setReport(null)
  }

  /**
   * ONE CLICK. Starts (or stops) camera, microphone, face analysis, voice
   * analysis, transcription and fusion together. The user never starts these
   * separately - that is the whole point of this handler.
   */
  const running = active || voiceActive

  /**
   * Speak with Aura IS the "analyse now" action for voice, combined into one
   * interactive control - starting the conversation also starts the same
   * voice-signal analysis pipeline (Distress Signal, Synchronized Signals,
   * Multimodal Timeline) that "Analyse Now" starts below, using the mic
   * permission the conversation already has. Camera stays a separate,
   * explicit opt-in inside the conversation card, never bundled in here.
   */
  const startConversationAnalysis = async () => {
    if (voiceActive) return
    const online = await checkBackendHealth()
    setBackendOnline(online)
    if (!online) return
    resetSessionState()
    setSessionStart(Date.now())
    setElapsed(0)
    setFatalError(null)
    setVoiceActive(true)
  }

  const stopConversationAnalysis = () => {
    setActive(false)
    setVoiceActive(false)
    setSessionStart(null)
    clearLiveReadings()
  }

  const handleAnalyseNow = async () => {
    if (running) {
      setActive(false)
      setVoiceActive(false)
      setSessionStart(null)
      setStarting(false)
      // Stop means the live values are no longer live. History is retained.
      clearLiveReadings()
      return
    }

    setStarting(true)
    try {
      const online = await checkBackendHealth()
      setBackendOnline(online)
      if (!online) {
        setFatalError(`Emotion Analysis Backend Offline. Expected: ${API_BASE_URL}`)
        return
      }

      resetSessionState()
      setSessionStart(Date.now())
      setElapsed(0)
      setFatalError(null)

      // Both modalities start together. Each component acquires its own
      // device and reports failure independently, so a denied microphone
      // still leaves a working face pipeline and vice versa.
      setActive(true)
      setVoiceActive(true)
    } finally {
      setStarting(false)
    }
  }

  const handleResult = (result: AnalyzeResponse) => {
    setLatest(result)
    faceRef.current = result
    // Only frames the backend actually analyzed become observations - a
    // skipped or uncertain frame must not enter the session statistics.
    if (!result.analysis_used || !result.emotion || !result.sentiment || !result.quality) return
    if (result.emotion.dominant === "uncertain") return

    const observation: Observation = {
      timestamp: Date.now(),
      emotion_scores: result.emotion.scores, // FUSED scores, not raw DeepFace
      sentiment: result.sentiment.scores,
      confidence: result.emotion.confidence,
      quality: result.quality.overall,
      expression_intensity: result.emotion.expression_intensity,
    }

    setObservations((prev) => {
      const next = prev.length >= MAX_OBSERVATIONS ? [...prev.slice(-MAX_OBSERVATIONS + 1), observation] : [...prev, observation]

      return next
    })
  }

  const handleGenerateReport = async () => {
    const finalElapsed = elapsed
    setActive(false)
    setVoiceActive(false)
    setSessionStart(null)
    setReportLoading(true)
    try {
      const result = await submitSessionReport(
        observations,
        voiceObservations,
        agreementSamples
      )
      setReport(result)

      // Persist the completed session to history - derived signals only.
      if (result.success && !result.insufficient_data) {
        await saveHistorySession({
          duration_seconds: finalElapsed,
          observed_emotion: result.dominant_emotion ?? auraResult?.combined.dominant ?? null,
          emotion_confidence: auraResult?.combined.confidence ?? null,
          distress_score: distressSignal?.score ?? result.distress?.score ?? null,
          distress_level: distressSignal?.level ?? result.distress?.level ?? null,
          sentiment_dominant: result.sentiment?.dominant ?? null,
          agreement: auraResult?.agreement.score ?? null,
          modalities: auraResult?.modalities_used ?? [],
          valid_observations: result.session?.valid_observations ?? observations.length,
          emotion_scores: result.emotion_distribution ?? {},
          sentiment_scores: result.sentiment
            ? {
                positive: result.sentiment.positive,
                neutral: result.sentiment.neutral,
                negative: result.sentiment.negative,
              }
            : {},
          factors: distressSignal?.factors ?? [],
          transcript_excerpt: transcriptLines.join(" ").slice(-1000) || null,
          notes: result.key_observations ?? [],
        })
      }
    } catch {
      setReport({
        success: false,
        insufficient_data: true,
        message: "Could not reach the backend to generate the report. Please try again.",
      })
    } finally {
      setReportLoading(false)
    }
  }

  const liveWindow = useMemo(() => {
    if (observations.length === 0) return []
    const latestTs = observations[observations.length - 1].timestamp
    return observations.filter((o) => o.timestamp >= latestTs - LIVE_WINDOW_MS)
  }, [observations])

  const liveDistress = useMemo(() => computeLiveDistress(liveWindow), [liveWindow])

  /**
   * Live distress signal. Runs on its own slower cadence than the per-frame
   * analysis, because it is a window-level aggregate - recomputing it every
   * frame would cost requests without changing the answer.
   */
  useEffect(() => {
    if (!running) return

    const tick = async () => {
      const window = observationsRef.current.slice(-20)
      if (window.length === 0) return

      const result = await fetchDistressSignal({
        emotion_window: window.map((o) => ({ ...o.emotion_scores })),
        sentiment_window: window.map((o) => ({ ...o.sentiment })),
        // Derived from the observed acoustic signal. Absent unless the
        // pipeline actually observed elevated activation - a steady voice
        // contributes no stress evidence rather than a zero measurement.
        voice_stress:
          frameRef.current?.voice_signal?.observed.startsWith("Elevated")
            ? frameRef.current.voice_signal.confidence / 100
            : null,
        face_motion: faceRef.current?.facial_evidence?.facial_motion ?? null,
        reliability: faceRef.current?.emotion?.reliability ?? 100,
        transcript: transcriptLinesRef.current.join(" ") || null,
      })
      if (result?.success) setDistressSignal(result)
    }

    const id = window.setInterval(tick, 4000)
    tick()
    return () => window.clearInterval(id)
  }, [running])

  const statusDot = useMemo(() => {
    if (!active && !voiceActive) return { color: "bg-slate-600", label: "IDLE" }
    if (active && cameraState === "error") return { color: "bg-rose-500", label: "ERROR" }
    const parts = [active && "CAMERA", voiceActive && "VOICE"].filter(Boolean)
    return { color: "bg-emerald-500 animate-pulse", label: `${parts.join(" + ")} ACTIVE` }
  }, [active, voiceActive, cameraState])

  const latestTextEmotion: TextEmotionInfo | null =
    latestFrame?.text_emotion
      ? (latestFrame.text_emotion as unknown as TextEmotionInfo)
      : null

  /** Live per-stage status for the one-click indicator row. */
  const pipelineStatus: PipelineStatus = useMemo(() => {
    const camera: PipelineStatus["camera"] = !active
      ? "off"
      : cameraState === "error"
      ? "error"
      : cameraState === "requesting_permission"
      ? "starting"
      : "active"

    const microphone: PipelineStatus["microphone"] = !voiceActive
      ? "off"
      : latestFrame === null
      ? "starting"
      : latestFrame.error
      ? "error"
      : "active"

    const face: PipelineStatus["face"] = !active
      ? "idle"
      : metrics.faceDetected
      ? "detected"
      : "not_detected"

    const voice: PipelineStatus["voice"] = !voiceActive
      ? "idle"
      : latestFrame?.speech_detected
      ? "speech"
      : "silence"

    const transcript: PipelineStatus["transcript"] = !voiceActive
      ? "idle"
      : transcriptLines.length > 0
      ? "receiving"
      : "none"

    return { camera, microphone, face, voice, transcript }
  }, [active, voiceActive, cameraState, latestFrame, metrics.faceDetected, transcriptLines.length])

  // Only a NAMED tone reaches the panel. A withheld label stays absent rather
  // than being shown as a weak or neutral reading.
  // The compact Voice card shows the SIGNAL (what was measured, e.g.
  // "Elevated vocal activation") and its own confidence - not the tone
  // model's emotion guess, which is a separate, weaker interpretation.
  const voiceInfoNow =
    latestFrame?.analysis_used && latestFrame.voice_signal
      ? {
          available: true,
          observed: latestFrame.voice_signal.observed,
          confidence: latestFrame.voice_signal.confidence,
        }
      : null

  /**
   * Navigates to the analysis view from Home's "Talk to AURA" tile.
   *
   * Deliberately does NOT auto-start the camera/microphone pipeline anymore -
   * that used to fire immediately on navigation, which silently turned the
   * camera on before the person had touched anything. Speak with Aura is the
   * primary way in now, and it acquires only the microphone until the person
   * explicitly opts into camera analysis.
   */
  const handleStartFromHome = () => {
    setPage("analysis")
  }

  const handleOpenCheckin = () => setPage("checkin")

  const heroDistressScore = distressSignal?.score ?? liveDistress.score
  const heroConfidence = distressSignal?.confidence ?? fusion?.emotion.confidence ?? null

  /** Plain-language stand-in for the raw distress score, for the victim's
   * own calm view - never a number, never a diagnostic claim. */
  const observationSummary = useMemo(() => {
    if (!running) return null
    const parts: string[] = []
    if (voiceInfoNow?.observed && voiceInfoNow.observed.toLowerCase() !== "steady vocal activation") {
      parts.push(`voice showed ${voiceInfoNow.observed.toLowerCase()}`)
    }
    if (latestTextEmotion?.available && latestTextEmotion.sentiment?.dominant) {
      const s = latestTextEmotion.sentiment.dominant.toLowerCase()
      if (s !== "neutral") parts.push(`speech leaned ${s}`)
    }
    if (active && latest?.emotion?.dominant && latest.emotion.dominant !== "neutral") {
      parts.push(`facial expression read as ${latest.emotion.dominant.toLowerCase()}`)
    }
    if (parts.length === 0) return "Aura hasn't noticed a clear pattern yet in this conversation."
    return `Aura noticed: ${parts.join("; ")}.`
  }, [running, voiceInfoNow, latestTextEmotion, active, latest])

  // The real microphone-capture/analysis loop, shared by both role views
  // below - always mounted so voice data keeps flowing regardless of which
  // layout is on screen, never rendered with its own verbose readout.
  const hiddenVoiceAnalysis = (
    <div className="hidden">
      <VoiceAnalysis
        active={voiceActive}
        capabilities={voiceCaps}
        language={language}
        sessionId={sessionIdRef.current}
        onFrame={handleVoiceFrame}
        onFatalError={(msg) => {
          setFatalError(msg)
          setVoiceActive(false)
        }}
      />
    </div>
  )

  /** Distress Signal circle + Synchronized Signals (Face/Voice/Text) +
   * camera/transcript side panel. Shared as-is between the counsellor's
   * dashboard and the victim's view - one definition, not two copies. */
  const topRowSection = (
    <section className="grid grid-cols-1 lg:grid-cols-12 gap-gutter">
      {/* Central Visualization */}
      <div className="lg:col-span-8 bg-surface-container-lowest rounded-[24px] shadow-ambient-lg p-stack-md flex flex-col md:flex-row items-center gap-stack-md relative overflow-hidden">
        <div className="w-full md:w-1/2 flex justify-center items-center relative">
          <div className="text-center bg-surface-container-low rounded-full p-8 shadow-ambient-md border border-outline-variant aspect-square flex flex-col items-center justify-center w-56 h-56">
            <p className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-1">Distress Signal</p>
            <p className="text-display-lg text-primary leading-none mb-2">
              {running ? Math.round(heroDistressScore) : "—"}
              <span className="text-headline-md text-outline">/100</span>
            </p>
            <div className="inline-flex items-center gap-2 bg-secondary-container text-on-secondary-container px-3 py-1 rounded-full text-label-sm">
              <span className="material-symbols-outlined text-[16px]">check_circle</span>
              Confidence {heroConfidence !== null ? `${Math.round(heroConfidence)}%` : "—"}
            </div>
          </div>
          <p className="text-label-sm text-outline text-center mt-3 max-w-[220px] mx-auto">
            Decision-support signal — not a clinical diagnosis.
          </p>
        </div>

        <div className="w-full md:w-1/2 flex flex-col gap-stack-sm">
          <h2 className="text-headline-md text-on-surface mb-2">Synchronized Signals</h2>

          <div className="bg-surface-container-low rounded-xl p-4 flex items-center justify-between border border-transparent hover:border-primary/20 transition-colors">
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 rounded-full bg-primary-container/10 flex items-center justify-center text-primary">
                <span className="material-symbols-outlined">face</span>
              </div>
              <div>
                <p className="text-label-sm text-on-surface-variant uppercase">Face · Emotion</p>
                <p className="text-body-md font-medium text-on-surface capitalize">
                  {active && latest?.emotion?.dominant ? latest.emotion.dominant : "Not detected"}
                </p>
              </div>
            </div>
            <div className="text-headline-md text-primary">
              {active && latest?.emotion?.confidence != null ? `${Math.round(latest.emotion.confidence)}%` : "—"}
            </div>
          </div>

          <div className="bg-surface-container-low rounded-xl p-4 flex items-center justify-between border border-transparent hover:border-secondary/20 transition-colors">
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 rounded-full bg-secondary-container/10 flex items-center justify-center text-secondary">
                <span className="material-symbols-outlined">graphic_eq</span>
              </div>
              <div>
                <p className="text-label-sm text-on-surface-variant uppercase">Voice · Signal</p>
                <p className="text-body-md font-medium text-on-surface capitalize">
                  {voiceInfoNow?.observed ?? "Not detected"}
                </p>
              </div>
            </div>
            <div className="text-headline-md text-secondary">
              {voiceInfoNow?.confidence != null ? `${Math.round(voiceInfoNow.confidence)}%` : "—"}
            </div>
          </div>

          <div className="bg-surface-container-low rounded-xl p-4 flex items-center justify-between border border-transparent hover:border-tertiary/20 transition-colors">
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 rounded-full bg-tertiary-container/10 flex items-center justify-center text-tertiary">
                <span className="material-symbols-outlined">chat</span>
              </div>
              <div>
                <p className="text-label-sm text-on-surface-variant uppercase">Text · Sentiment</p>
                <p className="text-body-md font-medium text-on-surface capitalize">
                  {latestTextEmotion?.available
                    ? latestTextEmotion.sentiment?.dominant ?? "Not detected"
                    : "Not detected"}
                </p>
              </div>
            </div>
            <div className="text-headline-md text-tertiary">
              {latestTextEmotion?.available && latestTextEmotion.confidence != null
                ? `${Math.round(latestTextEmotion.confidence)}%`
                : "—"}
            </div>
          </div>
        </div>
      </div>

      {/* Side Panel: Camera preview + transcript */}
      <div className="lg:col-span-4 flex flex-col gap-gutter">
        <div className="bg-surface-container-lowest rounded-[24px] shadow-ambient-md overflow-hidden relative aspect-[4/3] min-h-[380px]">
          <LiveEmotionCamera
            active={active}
            mode={mode}
            sessionId={sessionIdRef.current}
            onResult={handleResult}
            onStateChange={setCameraState}
            onFatalError={(msg) => {
              setFatalError(msg)
              setActive(false)
            }}
            onMetrics={handleMetrics}
          />
          {active && (
            <div className="absolute inset-0 z-0 pointer-events-none border-2 border-primary/30 m-6 rounded-lg">
              <div className="w-4 h-4 border-t-2 border-l-2 border-primary absolute top-0 left-0 -mt-1 -ml-1" />
              <div className="w-4 h-4 border-t-2 border-r-2 border-primary absolute top-0 right-0 -mt-1 -mr-1" />
              <div className="w-4 h-4 border-b-2 border-l-2 border-primary absolute bottom-0 left-0 -mb-1 -ml-1" />
              <div className="w-4 h-4 border-b-2 border-r-2 border-primary absolute bottom-0 right-0 -mb-1 -mr-1" />
            </div>
          )}
        </div>

        <LiveTranscript
          lines={transcriptLines}
          livePartial={livePartialTranscript}
          textEmotion={latestTextEmotion}
          groqInsight={groqInsight}
        />
      </div>
    </section>
  )

  const analysisView = (
    <div className="flex flex-col gap-stack-lg">
        {role !== "victim" && (
          <header className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <h1 className="text-headline-lg text-on-surface">Emotion Analysis</h1>
              <div className="flex items-center gap-2 text-label-sm font-medium">
                <span className={`w-2 h-2 rounded-full ${statusDot.color}`} />
                <span className="text-on-surface-variant">{statusDot.label}</span>
              </div>
            </div>
            <p className="text-body-lg text-on-surface-variant">
              Real-time multisensory emotional state monitoring.
            </p>
          </header>
        )}

        {backendOnline === false && (
          <div className="flex items-center gap-2 rounded-xl bg-error-container text-on-error-container text-body-md px-4 py-3">
            <WifiOff size={16} className="shrink-0" />
            Emotion Analysis Backend Offline — expected at {API_BASE_URL}
          </div>
        )}

        {fatalError && (
          <div className="rounded-xl bg-error-container text-on-error-container text-body-md px-4 py-3">
            {fatalError}
          </div>
        )}

        {role === "victim" ? (
          <>
            <AuraVoiceConversation
              cameraActive={active}
              onToggleCamera={(on) => setActive(on)}
              onStartAnalysis={startConversationAnalysis}
              onStopAnalysis={stopConversationAnalysis}
              onOpenSupport={() => setPage("support")}
              onOpenInsights={() => setPage("insights")}
              observationSummary={observationSummary}
            />

            {hiddenVoiceAnalysis}

            {topRowSection}

            <MyPatterns onStartCheckin={() => setPage("checkin")} />

            {reportLoading && (
              <div className="rounded-[24px] bg-surface-container-lowest border border-outline-variant p-6 text-center text-body-md text-on-surface-variant card-shadow">
                Generating final report from session observations...
              </div>
            )}
            {report && <SessionReportView report={report} onClose={() => setReport(null)} />}

            <details className="rounded-[24px] bg-surface-container-lowest border border-outline-variant p-stack-md">
              <summary className="cursor-pointer text-label-md font-semibold text-on-surface-variant">
                Analysis preferences
              </summary>
              <div className="mt-4">
                <AnalysisControls
                  running={running}
                  analysing={starting}
                  status={pipelineStatus}
                  mode={mode}
                  language={language}
                  languages={LANGUAGES}
                  canGenerateReport={observations.length >= MIN_OBSERVATIONS_FOR_REPORT && !reportLoading}
                  onToggle={handleAnalyseNow}
                  onModeChange={setMode}
                  onLanguageChange={setLanguage}
                  onGenerateReport={handleGenerateReport}
                />
              </div>
            </details>

            <details className="rounded-[24px] bg-surface-container-lowest border border-outline-variant p-stack-md">
              <summary className="cursor-pointer text-label-md font-semibold text-on-surface-variant">
                How Aura understands signals
              </summary>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-gutter mt-4">
                <div>
                  <h4 className="text-label-md font-semibold text-on-surface">Voice</h4>
                  <p className="text-label-sm text-on-surface-variant mt-1">Pitch, tempo and acoustic patterns.</p>
                </div>
                <div>
                  <h4 className="text-label-md font-semibold text-on-surface">Face</h4>
                  <p className="text-label-sm text-on-surface-variant mt-1">
                    Observable facial movement when camera analysis is enabled.
                  </p>
                </div>
                <div>
                  <h4 className="text-label-md font-semibold text-on-surface">Speech</h4>
                  <p className="text-label-sm text-on-surface-variant mt-1">
                    Words, themes and sentiment from the conversation.
                  </p>
                </div>
              </div>
              <p className="text-label-sm text-outline mt-4">
                These are observable signals, not measurements of a person's inner emotional state and
                not a clinical diagnosis.
              </p>
            </details>
          </>
        ) : (
          <>
            <AnalysisControls
              running={running}
              analysing={starting}
              status={pipelineStatus}
              mode={mode}
              language={language}
              languages={LANGUAGES}
              canGenerateReport={observations.length >= MIN_OBSERVATIONS_FOR_REPORT && !reportLoading}
              onToggle={handleAnalyseNow}
              onModeChange={setMode}
              onLanguageChange={setLanguage}
              onGenerateReport={handleGenerateReport}
            />

            {topRowSection}

            {hiddenVoiceAnalysis}

            <div className="rounded-[24px] bg-surface-container-lowest border border-outline-variant p-stack-md card-shadow">
              <h2 className="text-headline-md text-on-surface mb-3 flex items-center gap-2">
                <span className="material-symbols-outlined text-tertiary">timeline</span>
                Multimodal Timeline
              </h2>
              <MultimodalTimeline points={timeline} />
            </div>

            <div className="rounded-[24px] bg-surface-container-lowest border border-outline-variant p-stack-md card-shadow">
              <h2 className="text-headline-md text-on-surface mb-3 flex items-center gap-2">
                <span className="material-symbols-outlined text-tertiary">show_chart</span>
                Emotion Graph
              </h2>
              <EmotionTimeline observations={observations} />
            </div>

            {reportLoading && (
              <div className="rounded-[24px] bg-surface-container-lowest border border-outline-variant p-6 text-center text-body-md text-on-surface-variant card-shadow">
                Generating final report from session observations...
              </div>
            )}

            {report && <SessionReportView report={report} onClose={() => setReport(null)} />}

            {/* Methodology */}
            <section className="bg-surface-container-lowest rounded-[24px] shadow-ambient-md p-stack-md">
              <h3 className="text-headline-md text-on-surface mb-stack-sm text-center">How AURA Recognizes</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-gutter">
                <div className="flex flex-col items-center text-center p-4">
                  <div className="w-16 h-16 rounded-full bg-primary-container/10 flex items-center justify-center mb-4">
                    <span className="material-symbols-outlined text-[32px] text-primary">face_retouching_natural</span>
                  </div>
                  <h4 className="text-label-md font-semibold text-on-surface uppercase tracking-wide">Face</h4>
                  <p className="text-body-md text-on-surface-variant mt-2 text-sm">Powered by MediaPipe</p>
                  <p className="text-label-sm text-outline mt-1 max-w-[200px]">
                    Analyzes facial landmarks and region motion to detect micro-expressions.
                  </p>
                </div>
                <div className="flex flex-col items-center text-center p-4">
                  <div className="w-16 h-16 rounded-full bg-secondary-container/10 flex items-center justify-center mb-4">
                    <span className="material-symbols-outlined text-[32px] text-secondary">settings_voice</span>
                  </div>
                  <h4 className="text-label-md font-semibold text-on-surface uppercase tracking-wide">Voice</h4>
                  <p className="text-body-md text-on-surface-variant mt-2 text-sm">Acoustic Analysis</p>
                  <p className="text-label-sm text-outline mt-1 max-w-[200px]">
                    Measures pitch, tempo, and vocal tremor patterns.
                  </p>
                </div>
                <div className="flex flex-col items-center text-center p-4">
                  <div className="w-16 h-16 rounded-full bg-tertiary-container/10 flex items-center justify-center mb-4">
                    <span className="material-symbols-outlined text-[32px] text-tertiary">notes</span>
                  </div>
                  <h4 className="text-label-md font-semibold text-on-surface uppercase tracking-wide">Text</h4>
                  <p className="text-body-md text-on-surface-variant mt-2 text-sm">Local NLP + Groq</p>
                  <p className="text-label-sm text-outline mt-1 max-w-[200px]">
                    Local models score sentiment; Groq grounds concerns, themes and suggestions in your own words.
                  </p>
                </div>
              </div>
            </section>
          </>
        )}
    </div>
  )

  // --- Real auth gate: nobody sees a dashboard without a valid session. ---
  if (!authChecked) {
    return <div className="min-h-screen bg-background" />
  }

  if (!authUser) {
    if (!portalRole) {
      return <PortalSelector onSelect={setPortalRole} googleError={googleAuthError} />
    }
    return (
      <AuthScreen
        role={portalRole}
        resetToken={resetToken}
        onResetTokenConsumed={() => setResetToken(null)}
        onBack={() => setPortalRole(null)}
        onAuthenticated={(user) => {
          resetSyntheticDataSeed()
          setAuthUser(user)
          setPage(
            user.role === "counsellor" ? "cases" : user.role === "admin" ? "admin" : user.role === "guardian" ? "guardian" : "home"
          )
        }}
      />
    )
  }

  if (!authUser.onboarding_complete) {
    return (
      <OnboardingSurvey
        role={authUser.role}
        onComplete={() => setAuthUser({ ...authUser, onboarding_complete: true })}
      />
    )
  }

  return (
    <AppShell
      page={page}
      role={role}
      onNavigate={setPage}
      backendOnline={backendOnline}
      accountLabel={authUser.display_name || authUser.email}
      onLogout={handleLogout}
    >
      <div className="space-y-5">
        {role === "counsellor" && (
          <>
            {page === "cases" && <CounsellorDashboard />}
            {page === "counsellor-call" && <CounsellorCallPanel />}
            {page === "history-profile" && (
              <HistoryProfilePage capabilities={voiceCaps} backendOnline={backendOnline} />
            )}
          </>
        )}

        {role === "admin" && page === "admin" && <AdminDashboard />}

        {role === "guardian" && page === "guardian" && <GuardianDashboard />}

        {role === "victim" && (
          <>
            {page === "home" && (
              <VictimHome
                auraId={activeProfile}
                onOpenAnalysis={handleStartFromHome}
                onOpenCheckin={handleOpenCheckin}
                onOpenCompanion={() => setPage("companion")}
                onOpenWellbeing={() => setPage("insights")}
              />
            )}
            {page === "checkin" && (
              <CheckIn
                onDone={() => setPage("home")}
                onOpenCompanion={() => setPage("companion")}
                onOpenSupport={() => setPage("support")}
              />
            )}
            {page === "analysis" && analysisView}
            {page === "insights" && <WellbeingRiskPage onOpenCompanion={() => setPage("companion")} />}
            {page === "companion" && <AICompanion />}
            {page === "support" && (
              <Support
                auraId={activeProfile}
                onOpenCompanion={() => setPage("companion")}
                onOpenSafetyPlan={() => setPage("safety-plan")}
              />
            )}
            {page === "safety-plan" && <SafetyPlan />}
            {page === "history" && <HistoryPage />}
            {page === "profile" && <ProfilePage capabilities={voiceCaps} backendOnline={backendOnline} />}
          </>
        )}

        {/* Real-time incoming-call overlay: mounted globally for the victim
            role, on every page, since a call can arrive at any time - not
            tied to navigating to a specific page. */}
        {role === "victim" && <IvrsCallPortal />}
      </div>
    </AppShell>
  )
}
