// Continuous scanning: the camera keeps reading, and every text that holds steady is written down
// once, with a beep and a short vibration, so the tester can move on to the next item.
import type { FocusSweep } from './camera'
import type { Engine, TextRead } from './ocr/engine'
import { focusSharpness, frameRegion, grab, processedCopy, sharpnessOf, type Focuser, type ScanProgress } from './scanner'
import type { Settings } from './settings'

/** One label: every line read in the box together, top to bottom. */
export interface Capture {
  lines: string[]
  /** Average confidence of the lines' reads. */
  confidence: number
  /** Time since the start of the run when the label was first written down. */
  atMs: number
  /** The label (all its lines and a margin), cut from the frame. */
  crop: HTMLCanvasElement
}

/** A line split into words, each one searchable on its own. */
export const words = (line: string) => line.split(/\s+/).filter(Boolean)

const key = (t: string) => t.toUpperCase().replace(/\s+/g, ' ').trim()
const isIdentity = (t: string) => (t.match(/[0-9]/g) ?? []).length >= 4

export interface TrackerUpdate {
  /** A new label was started (beep). */
  started: boolean
  /** Lines added to the current label (including those of a new one). */
  added: string[]
}

/**
 * Turns frames of reads into labels. A line counts once it was read exactly the same way in `need`
 * of the last `window` frames. The steady lines belong to the current label, until:
 * - no steady line was seen for `gap` frames (the camera moved off the label), or
 * - fewer than half of the steady lines are in the current label (another label), or
 * - a new number of 4+ digits appears while the label already has one (same kind of label,
 *   different serial).
 * Then the next steady lines start a new label. Exact sameness, not similarity: neighbouring
 * serials differ by one character.
 */
export class LabelTracker {
  private recent: Set<string>[] = []
  private need: number
  private window: number
  private gap: number
  private emptyFrames = 0
  /** Lines of the current label, in reading order; null when there is none. */
  current: string[] | null = null

  constructor(need: number, window = 4, gap = 3) {
    this.need = need
    this.window = window
    this.gap = gap
  }

  /** The lines of one frame, top to bottom. */
  feed(lines: string[]): TrackerUpdate {
    const keys = lines.map(key).filter((k) => k.length > 0)
    this.recent.push(new Set(keys))
    if (this.recent.length > this.window) this.recent.shift()
    const steady = keys.filter((k, i) => keys.indexOf(k) === i && this.recent.filter((f) => f.has(k)).length >= this.need)
    if (!steady.length) {
      if (++this.emptyFrames >= this.gap) this.current = null
      return { started: false, added: [] }
    }
    this.emptyFrames = 0
    const cur = this.current
    const known = cur ? steady.filter((k) => cur.includes(k)).length : 0
    const newIdentity = cur !== null && cur.some(isIdentity) && steady.some((k) => isIdentity(k) && !cur.includes(k))
    if (!cur || known < steady.length / 2 || newIdentity) {
      this.current = steady
      // Lines seen before the switch must be seen again to count for the new label.
      this.recent = [new Set(keys)]
      return { started: true, added: steady }
    }
    const added = steady.filter((k) => !cur.includes(k))
    if (added.length) {
      // Reading order of this frame, then lines of the label not seen in it.
      this.current = [...steady, ...cur.filter((k) => !steady.includes(k))]
    }
    return { started: false, added }
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

function cropAround(frame: HTMLCanvasElement, reads: TextRead[]): HTMLCanvasElement {
  const m = Math.max(...reads.map((r) => r.box.thickness)) * 0.4
  const x = Math.max(0, Math.min(...reads.map((r) => r.box.x)) - m)
  const y = Math.max(0, Math.min(...reads.map((r) => r.box.y)) - m)
  const w = Math.min(frame.width - x, Math.max(...reads.map((r) => r.box.x + r.box.w)) + m - x)
  const h = Math.min(frame.height - y, Math.max(...reads.map((r) => r.box.y + r.box.h)) + m - y)
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
  /** Called when a label is started (`started`) and when lines are added to it. */
  onCapture: (c: Capture, started: boolean) => void,
  onProgress: (p: ScanProgress) => void,
  stop: { stopped: boolean },
  focuser: Focuser | null,
): Promise<ContinuousResult> {
  const start = performance.now()
  const tracker = new LabelTracker(s.voting ? 2 : 1)
  const captures: Capture[] = []
  const sweeps: FocusSweep[] = []
  const measure = () => focusSharpness(video, s)
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
      if (s.focusSweep && ++blurryInARow >= 2) {
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
    const update = tracker.feed(reads.map((r) => r.text))
    if (update.added.length && tracker.current) {
      const lines = tracker.current
      const inLabel = reads.filter((r) => lines.includes(key(r.text)))
      // Show each line as it was read (not the upper-case key used for comparing).
      const shown = lines.map((k) => reads.find((r) => key(r.text) === k)?.text ?? k)
      const confidence = inLabel.reduce((a, r) => a + r.confidence, 0) / Math.max(1, inLabel.length)
      const crop = cropAround(frame, inLabel.length ? inLabel : reads)
      if (update.started) {
        const c: Capture = { lines: shown, confidence, atMs: Math.round(performance.now() - start), crop }
        captures.push(c)
        onCapture(c, true)
      } else {
        const c = captures[captures.length - 1]
        c.lines = shown
        c.confidence = confidence
        c.crop = crop
        onCapture(c, false)
      }
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
