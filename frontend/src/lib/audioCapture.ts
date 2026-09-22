/**
 * Rolling audio capture producing 16 kHz mono WAV windows on two cadences.
 *
 * PARTIAL windows come from a short ring buffer and are sent several times a
 * second, so transcript text appears while the person is still speaking.
 * FINAL windows are whole utterances, accumulated from the first voiced frame
 * to the silence that ends it, and are sent once so the server can afford a
 * more accurate pass. Partial text is provisional and gets replaced by the
 * final text for the same span.
 *
 * Why this shape:
 *
 * - The AudioContext is created at 16 kHz directly, so the browser resamples
 *   for us and the captured PCM is already what the backend models want. That
 *   avoids both a JS resampler and an FFmpeg dependency on the server.
 *
 * - Partial audio lives in a fixed-size ring, so memory is bounded no matter
 *   how long the session runs and each request reads only the MOST RECENT
 *   window. Old audio is overwritten rather than queued, which keeps analysis
 *   real-time when inference is slower than capture.
 *
 * - The utterance buffer is hard-capped, so even an unbroken monologue cannot
 *   grow memory without bound - it is flushed as a final window at the cap.
 *
 * - Nothing is ever written to disk, and both buffers are zeroed on stop.
 */

const TARGET_SAMPLE_RATE = 16000

/**
 * Speech gate for utterance segmentation. This is a cheap client-side RMS
 * gate whose ONLY job is deciding when to send a final pass - it never
 * decides whether speech exists in the analysis. The server runs webrtcvad
 * for that. Hysteresis (a higher bar to start than to continue) stops a
 * borderline level from rapidly toggling utterance boundaries.
 */
const SPEECH_START_RMS = 0.012
const SPEECH_CONTINUE_RMS = 0.006

export interface AudioLevels {
  /** 0-1 instantaneous RMS, for the level meter. */
  rms: number
  /** Downsampled waveform for visualization only - never used for prediction. */
  waveform: Float32Array
}

/** A complete utterance ready for the accurate final pass. */
export interface Utterance {
  blob: Blob
  /** Seconds from capture start, for aligning with the server's window. */
  startSeconds: number
  endSeconds: number
}

export class RollingAudioCapture {
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private processor: ScriptProcessorNode | null = null
  private analyser: AnalyserNode | null = null

  private ring: Float32Array
  private writeIndex = 0
  private totalWritten = 0
  private readonly ringLength: number
  private sampleRate = TARGET_SAMPLE_RATE

  // --- Utterance segmentation ---
  private readonly silenceSamplesToEnd: number
  private readonly maxUtteranceSamples: number
  private utteranceChunks: Float32Array[] = []
  private utteranceLength = 0
  private utteranceStartSample = 0
  private speaking = false
  private trailingSilence = 0
  private pending: Utterance[] = []

  constructor(
    windowSeconds = 2,
    utteranceSilenceMs = 700,
    maxUtteranceSeconds = 20
  ) {
    this.ringLength = Math.round(TARGET_SAMPLE_RATE * windowSeconds)
    this.ring = new Float32Array(this.ringLength)
    this.silenceSamplesToEnd = Math.round((TARGET_SAMPLE_RATE * utteranceSilenceMs) / 1000)
    this.maxUtteranceSamples = Math.round(TARGET_SAMPLE_RATE * maxUtteranceSeconds)
  }

  /** Seconds of audio captured since start - the session clock for windows. */
  get elapsedSeconds(): number {
    return this.totalWritten / TARGET_SAMPLE_RATE
  }

  /** True while the client-side gate believes speech is in progress. */
  get isSpeaking(): boolean {
    return this.speaking
  }

  get active(): boolean {
    return this.context !== null && this.stream !== null
  }

  /** True once a full window of audio has been captured. */
  get hasFullWindow(): boolean {
    return this.totalWritten >= this.ringLength
  }

  /** Defensive re-resume: a browser tab losing focus/visibility can suspend
   * the context mid-conversation (silently - no error, no callback), so
   * callers on a recurring timer (waveform draw, turn-detection poll) call
   * this opportunistically rather than only once at start(). */
  resumeIfSuspended(): void {
    if (this.context && this.context.state === "suspended") {
      this.context.resume().catch(() => {})
    }
  }

  /**
   * Acquires the microphone and starts capture. The browser's own echo
   * cancellation and noise suppression are enabled: the analysis models are
   * trained on ordinary speech, so cleaner input is closer to their training
   * distribution, not further from it.
   */
  async start(): Promise<MediaStream> {
    if (this.stream) return this.stream

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    })

    // Requesting 16 kHz here means no resampling is needed later. Browsers
    // that refuse the hint fall back to their native rate, which we detect
    // and handle in encodeWindow().
    const context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
    this.sampleRate = context.sampleRate

    // A context created after an await gap from the triggering click (the
    // permission prompt above is exactly that gap) can start - and stay -
    // "suspended" in some Chromium builds, silently processing no audio at
    // all: the waveform never moves and nothing is ever transcribed, with no
    // error anywhere. Resuming explicitly is a no-op when already running.
    if (context.state === "suspended") {
      await context.resume().catch(() => {})
    }

    const source = context.createMediaStreamSource(stream)

    const analyser = context.createAnalyser()
    analyser.fftSize = 2048
    analyser.smoothingTimeConstant = 0.6
    source.connect(analyser)

    // ScriptProcessorNode is deprecated in favour of AudioWorklet, but is used
    // deliberately here: the work per callback is a single array copy, the
    // support matrix is universal, and it avoids shipping a separate worklet
    // module. If capture ever becomes a bottleneck this is the piece to move
    // to an AudioWorklet.
    const bufferSize = 4096
    const processor = context.createScriptProcessor(bufferSize, 1, 1)
    processor.onaudioprocess = (event) => {
      this.push(event.inputBuffer.getChannelData(0))
    }
    source.connect(processor)

    // A ScriptProcessorNode only runs while connected to a destination. Route
    // it through a zero gain node so nothing is played back to the user - the
    // microphone must never be echoed to the speakers.
    const mute = context.createGain()
    mute.gain.value = 0
    processor.connect(mute)
    mute.connect(context.destination)

    this.stream = stream
    this.context = context
    this.source = source
    this.processor = processor
    this.analyser = analyser

    return stream
  }

  private push(chunk: Float32Array) {
    for (let i = 0; i < chunk.length; i++) {
      this.ring[this.writeIndex] = chunk[i]
      this.writeIndex = (this.writeIndex + 1) % this.ringLength
    }

    let sumSquares = 0
    for (let i = 0; i < chunk.length; i++) sumSquares += chunk[i] * chunk[i]
    const rms = Math.sqrt(sumSquares / (chunk.length || 1))

    const chunkStart = this.totalWritten
    this.totalWritten += chunk.length
    this.segmentUtterance(chunk, rms, chunkStart)
  }

  /**
   * Accumulates the current utterance and closes it after enough trailing
   * silence. Copying the chunk matters: the Web Audio buffer handed to
   * onaudioprocess is REUSED by the browser, so retaining it without a copy
   * would corrupt earlier audio with later samples.
   */
  private segmentUtterance(chunk: Float32Array, rms: number, chunkStart: number) {
    const loud = this.speaking ? rms >= SPEECH_CONTINUE_RMS : rms >= SPEECH_START_RMS

    if (loud) {
      if (!this.speaking) {
        this.speaking = true
        this.utteranceChunks = []
        this.utteranceLength = 0
        this.utteranceStartSample = chunkStart
      }
      this.trailingSilence = 0
      this.utteranceChunks.push(new Float32Array(chunk))
      this.utteranceLength += chunk.length
    } else if (this.speaking) {
      // Keep trailing silence in the buffer: the recognizer transcribes the
      // end of a word more reliably when the audio does not stop mid-phoneme.
      this.utteranceChunks.push(new Float32Array(chunk))
      this.utteranceLength += chunk.length
      this.trailingSilence += chunk.length
      if (this.trailingSilence >= this.silenceSamplesToEnd) {
        this.closeUtterance()
      }
    }

    // A monologue must still produce final passes, and must not grow forever.
    if (this.speaking && this.utteranceLength >= this.maxUtteranceSamples) {
      this.closeUtterance()
    }
  }

  private closeUtterance() {
    const samples = this.flattenUtterance()
    const startSeconds = this.utteranceStartSample / TARGET_SAMPLE_RATE
    const endSeconds = (this.utteranceStartSample + this.utteranceLength) / TARGET_SAMPLE_RATE

    this.speaking = false
    this.trailingSilence = 0
    this.utteranceChunks = []
    this.utteranceLength = 0

    if (samples.length < TARGET_SAMPLE_RATE * 0.4) return // too short to be speech

    const encoded =
      this.sampleRate === TARGET_SAMPLE_RATE
        ? samples
        : resampleLinear(samples, this.sampleRate, TARGET_SAMPLE_RATE)

    // Bounded queue: if the network cannot keep up, the OLDEST pending
    // utterance is dropped rather than letting the queue grow without limit.
    // Dropping the newest would be worse - it is the one the user just said.
    this.pending.push({
      blob: encodeWav(encoded, TARGET_SAMPLE_RATE),
      startSeconds,
      endSeconds,
    })
    if (this.pending.length > 3) this.pending.shift()
  }

  private flattenUtterance(): Float32Array {
    const out = new Float32Array(this.utteranceLength)
    let offset = 0
    for (const c of this.utteranceChunks) {
      out.set(c, offset)
      offset += c.length
    }
    return out
  }

  /** Removes and returns the next finished utterance, if any. */
  takeUtterance(): Utterance | null {
    return this.pending.shift() ?? null
  }

  /** Current levels for visualization. Returns null when inactive. */
  getLevels(): AudioLevels | null {
    if (!this.analyser) return null
    const buffer = new Float32Array(this.analyser.fftSize)
    this.analyser.getFloatTimeDomainData(buffer)

    let sumSquares = 0
    for (let i = 0; i < buffer.length; i++) sumSquares += buffer[i] * buffer[i]
    const rms = Math.sqrt(sumSquares / buffer.length)

    // Downsample to a fixed number of bars for a stable-looking waveform.
    const bars = 48
    const waveform = new Float32Array(bars)
    const step = Math.floor(buffer.length / bars)
    for (let b = 0; b < bars; b++) {
      let peak = 0
      for (let i = 0; i < step; i++) {
        const v = Math.abs(buffer[b * step + i] ?? 0)
        if (v > peak) peak = v
      }
      waveform[b] = peak
    }
    return { rms, waveform }
  }

  /**
   * Encodes the most recent window as a 16 kHz mono 16-bit WAV Blob.
   * Returns null until a full window has been captured.
   */
  encodeWindow(): Blob | null {
    if (!this.hasFullWindow) return null

    // Unwrap the ring into chronological order.
    const ordered = new Float32Array(this.ringLength)
    const tail = this.ringLength - this.writeIndex
    ordered.set(this.ring.subarray(this.writeIndex), 0)
    ordered.set(this.ring.subarray(0, this.writeIndex), tail)

    // If the browser ignored the 16 kHz hint, linearly resample. The backend
    // also handles non-16k input, but converting here keeps uploads small.
    const samples =
      this.sampleRate === TARGET_SAMPLE_RATE
        ? ordered
        : resampleLinear(ordered, this.sampleRate, TARGET_SAMPLE_RATE)

    return encodeWav(samples, TARGET_SAMPLE_RATE)
  }

  stop() {
    if (this.processor) {
      this.processor.onaudioprocess = null
      this.processor.disconnect()
      this.processor = null
    }
    this.source?.disconnect()
    this.source = null
    this.analyser?.disconnect()
    this.analyser = null

    // This class acquired the stream, so it releases it. Without this the
    // microphone indicator stays on after the session stops.
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop())
      this.stream = null
    }
    if (this.context && this.context.state !== "closed") {
      this.context.close().catch(() => {})
    }
    this.context = null

    // Discard buffered audio immediately on stop. Both buffers, not just the
    // ring - a half-captured utterance is still the user's voice.
    this.ring.fill(0)
    this.writeIndex = 0
    this.totalWritten = 0
    this.utteranceChunks = []
    this.utteranceLength = 0
    this.pending = []
    this.speaking = false
    this.trailingSilence = 0
  }
}

function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input
  const ratio = toRate / fromRate
  const outLength = Math.floor(input.length * ratio)
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const pos = i / ratio
    const idx = Math.floor(pos)
    const frac = pos - idx
    const a = input[idx] ?? 0
    const b = input[idx + 1] ?? a
    out[i] = a + (b - a) * frac
  }
  return out
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample)
  const view = new DataView(buffer)

  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }

  const dataSize = samples.length * bytesPerSample
  writeString(0, "RIFF")
  view.setUint32(4, 36 + dataSize, true)
  writeString(8, "WAVE")
  writeString(12, "fmt ")
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * bytesPerSample, true) // byte rate
  view.setUint16(32, bytesPerSample, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeString(36, "data")
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
    offset += bytesPerSample
  }

  return new Blob([buffer], { type: "audio/wav" })
}
