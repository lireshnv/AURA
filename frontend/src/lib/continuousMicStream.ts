/**
 * Continuous 16kHz mono PCM16 mic capture for the realtime voice path - NOT
 * RollingAudioCapture (audioCapture.ts), which is intentionally left alone
 * (still used by the batch/VAD-segmented legacy voice pipeline). This class
 * is much simpler: no ring buffer, no client-side VAD/utterance
 * segmentation, no pending queue - every captured chunk is handed to the
 * caller immediately to stream over the wire. Confirmed empirically that
 * Gemini Live's OWN server-side VAD needs continuous audio (including
 * silence) to detect turn boundaries, so there is nothing useful for the
 * client to decide here - it only captures and forwards.
 */
const TARGET_SAMPLE_RATE = 16000

export interface AudioLevels {
  rms: number
  waveform: Float32Array
}

export class ContinuousMicStream {
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private processor: ScriptProcessorNode | null = null
  private analyser: AnalyserNode | null = null
  private sampleRate = TARGET_SAMPLE_RATE

  get active(): boolean {
    return this.context !== null && this.stream !== null
  }

  /** Defensive re-resume, same reasoning as RollingAudioCapture's: a
   * backgrounded tab can silently suspend the context mid-conversation. */
  resumeIfSuspended(): void {
    if (this.context && this.context.state === "suspended") {
      this.context.resume().catch(() => {})
    }
  }

  async start(onChunk: (pcm: ArrayBuffer) => void): Promise<MediaStream> {
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

    const context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
    this.sampleRate = context.sampleRate
    if (context.state === "suspended") {
      await context.resume().catch(() => {})
    }

    const source = context.createMediaStreamSource(stream)

    const analyser = context.createAnalyser()
    analyser.fftSize = 2048
    analyser.smoothingTimeConstant = 0.6
    source.connect(analyser)

    // 512 samples @ 16kHz = 32ms/chunk - within Gemini Live's recommended
    // 20-40ms range, so audio reaches the relay (and Gemini's own VAD) as
    // soon as possible rather than batching a quarter-second before sending.
    const bufferSize = 512
    const processor = context.createScriptProcessor(bufferSize, 1, 1)
    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0)
      const pcm =
        this.sampleRate === TARGET_SAMPLE_RATE
          ? floatTo16BitPCM(input)
          : floatTo16BitPCM(resampleLinear(input, this.sampleRate, TARGET_SAMPLE_RATE))
      onChunk(pcm)
    }
    source.connect(processor)

    // Route through a zero-gain node so the mic is never echoed to speakers
    // (ScriptProcessorNode only runs while connected to a destination).
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

  getLevels(): AudioLevels | null {
    if (!this.analyser) return null
    const buffer = new Float32Array(this.analyser.fftSize)
    this.analyser.getFloatTimeDomainData(buffer)

    let sumSquares = 0
    for (let i = 0; i < buffer.length; i++) sumSquares += buffer[i] * buffer[i]
    const rms = Math.sqrt(sumSquares / buffer.length)

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

  stop(): void {
    if (this.processor) {
      this.processor.onaudioprocess = null
      this.processor.disconnect()
      this.processor = null
    }
    this.source?.disconnect()
    this.source = null
    this.analyser?.disconnect()
    this.analyser = null
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop())
      this.stream = null
    }
    if (this.context && this.context.state !== "closed") {
      this.context.close().catch(() => {})
    }
    this.context = null
  }
}

function floatTo16BitPCM(input: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(input.length * 2)
  const view = new DataView(buffer)
  for (let i = 0; i < input.length; i++) {
    const clamped = Math.max(-1, Math.min(1, input[i]))
    view.setInt16(i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
  }
  return buffer
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
