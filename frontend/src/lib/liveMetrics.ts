import { EmotionScores, Observation } from "../types"

const NEGATIVE_KEYS: (keyof EmotionScores)[] = ["sad", "angry", "fear", "disgust"]
const EMOTION_KEYS: (keyof EmotionScores)[] = [
  "angry",
  "disgust",
  "fear",
  "happy",
  "sad",
  "surprise",
  "neutral",
]

function negativeProb(scores: EmotionScores): number {
  return NEGATIVE_KEYS.reduce((sum, k) => sum + scores[k], 0)
}

function positiveProb(scores: EmotionScores): number {
  return scores.happy + 0.5 * scores.surprise
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

/** Lightweight rolling estimate for the live dashboard - the authoritative,
 * evidence-backed score is only computed server-side in the final report. */
export function computeLiveDistress(window: Observation[]): { score: number; level: string } {
  if (window.length === 0) return { score: 0, level: "Low" }

  const negativeSeries = window.map((o) => negativeProb(o.emotion_scores))
  const positiveSeries = window.map((o) => positiveProb(o.emotion_scores))
  const avgNegative = negativeSeries.reduce((a, b) => a + b, 0) / negativeSeries.length
  const avgPositive = positiveSeries.reduce((a, b) => a + b, 0) / positiveSeries.length
  const sustainedRatio = negativeSeries.filter((n) => n > 40).length / negativeSeries.length
  const avgQuality = window.reduce((a, o) => a + o.quality, 0) / window.length

  const persistenceFactor = 0.5 + 0.5 * sustainedRatio
  const reliabilityFactor = 0.5 + 0.5 * (avgQuality / 100)
  const raw = avgNegative * persistenceFactor * reliabilityFactor - avgPositive * 0.15
  const score = Math.round(Math.max(0, Math.min(100, raw)))

  let level = "Low"
  if (score >= 75) level = "High"
  else if (score >= 50) level = "Elevated"
  else if (score >= 25) level = "Mild"

  return { score, level }
}

export function computeStability(window: Observation[]): { score: number; label: string } {
  if (window.length < 2) return { score: 100, label: "Stable" }

  const perEmotionStdev = EMOTION_KEYS.map((k) => stdev(window.map((o) => o.emotion_scores[k])))
  const avgStdev = perEmotionStdev.reduce((a, b) => a + b, 0) / perEmotionStdev.length
  const instability = Math.min(100, avgStdev * 2.5)
  const score = Math.round(Math.max(0, 100 - instability))
  const label = score >= 70 ? "Stable" : score >= 40 ? "Moderate" : "Variable"
  return { score, label }
}
