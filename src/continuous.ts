// Continuous scanning: the camera keeps reading, and every text that holds steady is written down
// once, with a beep and a short vibration, so the tester can move on to the next item.
import type { FocusSweep } from './camera'
import type { Engine, TextRead } from './ocr/engine'
import { frameRegion, grab, processedCopy, sharpnessOf, type Focuser, type ScanProgress } from './scanner'
import type { Settings } from './settings'

export interface Capture {
  text: string
  confidence: number
  /** Time since the start of the run. */
  atMs: number
  /** In how many of the recent frames the text was seen when it was written down. */
  frames: number
  /** The text and a margin around it, cut from the frame. */
  crop: HTMLCanvasElement
}

const key = (t: string) => t.toUpperCase().replace(/\s+/g, ' ').trim()

/**
 * Decides which reads become captures. A text is written down when it was read the same way in
 * `need` of the last `window` frames, and only once per run (the same text again is ignored).
 * Exact sameness, not similarity: neighbouring serials differ by one character.
 */
export class Collector {
  private recent: Set<string>[] = []
  private taken = new Set<string>()
  private need: number
  private window: number

  constructor(need: number, window = 4) {
    this.need = need
    this.window = window
  }

  /** The texts of one frame; returns those to write down now. */
  feed(texts: string[]): string[] {
    const keys = new Set(texts.map(key).filter((k) => k.length > 0))
    this.recent.push(keys)
    if (this.recent.length > this.window) this.recent.shift()
    const out: string[] = []
    for (const k of keys) {
      if (this.taken.has(k)) continue
      const seen = this.recent.filter((f) => f.has(k)).length
      if (seen >= this.need) {
        this.taken.add(k)
        out.push(k)
      }
    }
    return out
  }

  seenCount(text: string): number {
    const k = key(text)
    return this.recent.filter((f) => f.has(k)).length
  }
}

/** A short beep and vibration (vibration is not available on iPhone). */
export function signal(audio: AudioContext | null) {
  navigator.vibrate?.(60)
  if (!audio) return
  const osc = audio.createOscillator()
  const gain = audio.createGain()
  osc.frequency.value = 1800
  gain.gain.setValueAtTime(0.25, audio.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.09)
  osc.connect(gain).connect(audio.destination)
  osc.start()
  osc.stop(audio.currentTime + 0.1)
}

function cropAround(frame: HTMLCanvasElement, r: TextRead): HTMLCanvasElement {
  const m = r.box.thickness * 0.4
  const x = Math.max(0, r.box.x - m)
  const y = Math.max(0, r.box.y - m)
  const w = Math.min(frame.width - x, r.box.w + 2 * m)
  const h = Math.min(frame.height - y, r.box.h + 2 * m)
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w))
  c.height = Math.max(1, Math.round(h))
  c.getContext('2d')!.drawImage(frame, x, y, w, h, 0, 0, c.width, c.height)
  return c
}

export interface ContinuousResult {
  captures: Capture[]
  last: HTMLCanvasElement | null
  framesRead: number
  framesBlurry: number
  sharpness: number
  sweeps: FocusSweep[]
  durationMs: number
}

export async function runContinuous(
  video: HTMLVideoElement,
  engine: Engine,
  s: Settings,
  onCapture: (c: Capture) => void,
  onProgress: (p: ScanProgress) => void,
  stop: { stopped: boolean },
  focuser: Focuser | null,
): Promise<ContinuousResult> {
  const start = performance.now()
  const collector = new Collector(s.voting ? 2 : 1)
  const captures: Capture[] = []
  const sweeps: FocusSweep[] = []
  const measure = () => sharpnessOf(grab(video, frameRegion(video, s)), 640)
  const sweep = async () => {
    const r = focuser ? await focuser(measure) : null
    if (r) sweeps.push(r)
  }
  if (s.focusSweep) await sweep()
  let blurryInARow = 0
  let framesRead = 0
  let framesBlurry = 0
  let sharpSum = 0
  let last: HTMLCanvasElement | null = null

  while (!stop.stopped) {
    const region = frameRegion(video, s)
    const frame = grab(video, region)
    last = frame
    const sharp = sharpnessOf(frame)
    if (sharp < s.blurThreshold) {
      framesBlurry++
      onProgress({ sharpness: sharp, framesRead, framesBlurry, lastReads: [], region, scale: frame.width / region.w })
      // Moving to the next item blurs the picture: look for the focus again (no limit here).
      if (s.focusSweep && ++blurryInARow >= 4) {
        blurryInARow = 0
        await sweep()
      }
      await new Promise((r) => setTimeout(r, 30))
      continue
    }
    blurryInARow = 0
    const reads = await engine.read(s.preprocess ? processedCopy(frame) : frame, {
      detLimit: s.detLimit,
      minConfidence: s.minConfidence,
      maxBoxes: 12,
    })
    framesRead++
    sharpSum += sharp
    onProgress({ sharpness: sharp, framesRead, framesBlurry, lastReads: reads, region, scale: frame.width / region.w })
    for (const k of collector.feed(reads.map((r) => r.text))) {
      const r = reads.find((x) => key(x.text) === k)!
      const c: Capture = {
        text: r.text,
        confidence: r.confidence,
        atMs: Math.round(performance.now() - start),
        frames: collector.seenCount(r.text),
        crop: cropAround(frame, r),
      }
      captures.push(c)
      onCapture(c)
    }
    // Give the screen a moment between frames, so the list updates and the stop button answers.
    await new Promise((r) => setTimeout(r, 30))
  }
  return {
    captures,
    last,
    framesRead,
    framesBlurry,
    sharpness: framesRead ? Math.round(sharpSum / framesRead) : 0,
    sweeps,
    durationMs: Math.round(performance.now() - start),
  }
}
