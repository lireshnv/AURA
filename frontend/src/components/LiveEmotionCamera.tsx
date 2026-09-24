import { useCallback, useEffect, useRef, useState } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { Camera, CameraOff, AlertTriangle } from "lucide-react"
import { CameraState, PerformanceMode, MODE_INTERVALS, AnalyzeResponse, DebugMetrics } from "../types"
import { analyzeEmotion } from "../lib/api"

// Higher-fidelity capture than before (was 416x312 @ 0.75): more detail for
// the face detector and the emotion model to work with, at a JPEG size that
// is still small enough to upload well within the analysis interval.
const CAPTURE_WIDTH = 640
const CAPTURE_HEIGHT = 480
const JPEG_QUALITY = 0.9

interface Props {
  active: boolean
  mode: PerformanceMode
  sessionId: string
  onResult: (result: AnalyzeResponse) => void
  onStateChange: (state: CameraState) => void
  onFatalError: (message: string) => void
  onMetrics: (patch: Partial<DebugMetrics>) => void
}

export default function LiveEmotionCamera({
  active,
  mode,
  sessionId,
  onResult,
  onStateChange,
  onFatalError,
  onMetrics,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const captureCanvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const isAnalyzingRef = useRef(false)
  const intervalRef = useRef<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const analysisCountRef = useRef(0)
  const skippedCountRef = useRef(0)
  const endedCleanupRef = useRef<(() => void) | null>(null)

  const [state, setState] = useState<CameraState>("off")
  const [statusMessage, setStatusMessage] = useState<string>("")
  const [faceOk, setFaceOk] = useState(false)
  const [isReady, setIsReady] = useState(false)

  const setBoth = useCallback(
    (s: CameraState) => {
      setState(s)
      onStateChange(s)
    },
    [onStateChange]
  )

  const stopCamera = useCallback(() => {
    if (intervalRef.current) {
      window.clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    abortRef.current?.abort()
    endedCleanupRef.current?.()
    endedCleanupRef.current = null
    // This component acquired the stream, so it releases it. Without this the
    // camera light stays on after the session stops.
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
    analysisCountRef.current = 0
    skippedCountRef.current = 0
    setBoth("off")
    setFaceOk(false)
    setStatusMessage("")
    setIsReady(false)
    onMetrics({
      cameraActive: false,
      videoWidth: 0,
      videoHeight: 0,
      analysisCount: 0,
      skippedCount: 0,
      faceDetected: false,
      latest: null,
    })
  }, [setBoth, onMetrics])

  const runAnalysis = useCallback(async () => {
    if (isAnalyzingRef.current) return // skip overlapping requests
    const video = videoRef.current
    const canvas = captureCanvasRef.current
    if (!video || !canvas || video.readyState < 2) return

    // Never capture before the browser has real decoded video dimensions -
    // a 0x0 video produces a blank/garbage frame that DeepFace can't use.
    if (video.videoWidth === 0 || video.videoHeight === 0) return

    isAnalyzingRef.current = true
    setBoth("analyzing")

    canvas.width = CAPTURE_WIDTH
    canvas.height = CAPTURE_HEIGHT
    const ctx = canvas.getContext("2d")
    if (!ctx) {
      isAnalyzingRef.current = false
      return
    }
    ctx.drawImage(video, 0, 0, CAPTURE_WIDTH, CAPTURE_HEIGHT)

    canvas.toBlob(
      async (blob) => {
        if (!blob || blob.size === 0) {
          isAnalyzingRef.current = false
          return
        }
        onMetrics({ lastFrameSizeKb: blob.size / 1024 })

        const controller = new AbortController()
        abortRef.current = controller
        const startedAt = performance.now()
        try {
          const result = await analyzeEmotion(blob, sessionId, controller.signal)
          const elapsedMs = Math.round(performance.now() - startedAt)

          if (!result.success) {
            skippedCountRef.current += 1
            onMetrics({
              apiStatus: "error",
              lastResponseMs: elapsedMs,
              lastAnalysisAt: Date.now(),
              lastError: result.error ?? "Unknown analysis error",
              skippedCount: skippedCountRef.current,
            })
            setStatusMessage("Emotion analysis is temporarily unavailable. Retrying automatically...")
            setBoth("error")
            return
          }

          // analysis_used=False means the backend deliberately skipped a
          // frame (bad quality / no face) rather than inventing an emotion.
          const isValid = result.analysis_used && !!result.emotion
          if (isValid) {
            analysisCountRef.current += 1
          } else {
            skippedCountRef.current += 1
          }

          onResult(result)
          onMetrics({
            apiStatus: "connected",
            lastResponseMs: elapsedMs,
            lastAnalysisAt: Date.now(),
            lastError: null,
            faceDetected: result.face_detected,
            analysisCount: analysisCountRef.current,
            skippedCount: skippedCountRef.current,
            latest: result,
          })

          if (isValid) {
            setFaceOk(true)
            setStatusMessage("")
            setBoth("result")
          } else {
            setFaceOk(false)
            setStatusMessage(result.message ?? "Face not detected.")
            setBoth("detecting")
          }
        } catch (err) {
          if ((err as Error).name !== "AbortError") {
            skippedCountRef.current += 1
            const message = (err as Error).message || "Network error contacting the backend."
            onMetrics({ apiStatus: "error", lastError: message, skippedCount: skippedCountRef.current })
            setStatusMessage("Emotion analysis is temporarily unavailable. Retrying automatically...")
            setBoth("error")
          }
        } finally {
          isAnalyzingRef.current = false
        }
      },
      "image/jpeg",
      JPEG_QUALITY
    )
  }, [onMetrics, onResult, sessionId, setBoth])

  useEffect(() => {
    if (!active) {
      stopCamera()
      return
    }

    let cancelled = false

    async function start() {
      setBoth("requesting_permission")
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "user",
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 15, max: 24 },
          },
          audio: false,
        })

        // The user can stop the session while the permission prompt is open.
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }

        streamRef.current = stream
        const video = videoRef.current
        if (!video) return
        video.srcObject = stream

        // A track can end without warning - device unplugged, or the OS
        // revoking access. Without this the preview freezes on the last
        // frame and analysis keeps sampling that stale image indefinitely.
        const track = stream.getVideoTracks()[0]
        if (track) {
          const onEnded = () => {
            if (cancelled) return
            onFatalError("The camera stopped unexpectedly. Start the session again.")
            setBoth("error")
          }
          track.addEventListener("ended", onEnded)
          endedCleanupRef.current = () => track.removeEventListener("ended", onEnded)
        }

        await video.play()

        // Wait for real decoded dimensions before declaring the camera
        // ready. play() can resolve before the first frame has decoded, and
        // sampling a 0x0 video yields a blank frame.
        if (video.videoWidth === 0 || video.videoHeight === 0) {
          await new Promise<void>((resolve) => {
            const onLoaded = () => {
              video.removeEventListener("loadedmetadata", onLoaded)
              resolve()
            }
            video.addEventListener("loadedmetadata", onLoaded)
            // Don't hang forever if the event never fires.
            window.setTimeout(resolve, 5000)
          })
        }

        if (cancelled) return
        onMetrics({
          cameraActive: true,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
        })
        setBoth("ready")
        setIsReady(true)
      } catch (err) {
        if (cancelled) return
        const name = (err as Error).name
        if (name === "NotAllowedError" || name === "PermissionDeniedError") {
          onFatalError("Camera access is required for facial emotion analysis.")
        } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
          onFatalError("No camera device was detected.")
        } else if (name === "NotReadableError") {
          onFatalError("The camera is in use by another application.")
        } else {
          onFatalError("Unable to access the camera.")
        }
        setBoth("error")
      }
    }

    start()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  useEffect(() => {
    if (!active || !isReady) return

    intervalRef.current = window.setInterval(() => {
      runAnalysis()
    }, MODE_INTERVALS[mode])

    // Run one immediately on activation so the user isn't waiting a full interval.
    runAnalysis()

    return () => {
      if (intervalRef.current) {
        window.clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, mode, isReady])

  useEffect(() => stopCamera, []) // cleanup on unmount

  const statusLabel: Record<CameraState, string> = {
    off: "Camera Off",
    requesting_permission: "Requesting Permission...",
    ready: "Camera Ready",
    detecting: "Face Not Detected",
    analyzing: "Analyzing Emotion",
    result: "Face Detected",
    error: "Error",
  }

  return (
    <div className="relative w-full h-full rounded-xl overflow-hidden bg-surface-container-low border border-outline-variant">
      <video
        ref={videoRef}
        muted
        playsInline
        className="w-full h-full object-cover -scale-x-100"
      />
      <canvas ref={captureCanvasRef} className="hidden" />

      <AnimatePresence>
        {state === "result" && faceOk && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="pointer-events-none absolute inset-6 rounded-2xl border-2 border-emerald-500 shadow-[0_0_24px_rgba(52,211,153,0.35)]"
          />
        )}
      </AnimatePresence>

      {/* Viewfinder corner brackets - only while actually live, so the frame
          reads as an active instrument rather than decoration on a static
          image. Pure CSS, no impact on the captured/analyzed frame itself. */}
      {active && state !== "off" && (
        <div className="pointer-events-none absolute inset-4">
          {(["top-4 left-4 border-t-2 border-l-2 rounded-tl-lg", "top-4 right-4 border-t-2 border-r-2 rounded-tr-lg", "bottom-4 left-4 border-b-2 border-l-2 rounded-bl-lg", "bottom-4 right-4 border-b-2 border-r-2 rounded-br-lg"] as const).map(
            (pos) => (
              <span
                key={pos}
                className={`absolute w-6 h-6 ${pos} ${
                  state === "result" && faceOk ? "border-emerald-400/80" : "border-white/50"
                } transition-colors duration-300`}
              />
            )
          )}
        </div>
      )}

      <div className="absolute top-3 left-3 flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/50 backdrop-blur text-xs font-medium text-on-surface">
        {state === "off" ? (
          <CameraOff size={14} className="text-on-surface-variant" />
        ) : (
          <span className="relative flex h-2.5 w-2.5">
            {state === "analyzing" && (
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
            )}
            <span
              className={`relative inline-flex rounded-full h-2.5 w-2.5 ${
                state === "result" ? "bg-emerald-500" : state === "error" ? "bg-red-500" : "bg-amber-500"
              }`}
            />
          </span>
        )}
        <span>{statusLabel[state]}</span>
      </div>

      {active && isReady && (
        <div className="absolute top-3 right-3 px-2.5 py-1 rounded-full bg-black/50 backdrop-blur text-[10px] font-medium text-slate-100 flex items-center gap-1">
          <Camera size={11} className="text-slate-300" />
          {Math.round(1000 / MODE_INTERVALS[mode])}/s
        </div>
      )}

      {statusMessage && state !== "off" && (
        <div className="absolute bottom-3 left-3 right-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-xs">
          <AlertTriangle size={14} className="shrink-0" />
          <span>{statusMessage}</span>
        </div>
      )}

      {!active && (
        <div className="absolute inset-0 flex items-center justify-center text-on-surface-variant text-sm">
          Camera is off
        </div>
      )}
    </div>
  )
}
