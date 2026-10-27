// Continuous scanning: the camera keeps reading, and every text that holds steady is written down
// once, with a beep and a short vibration, so the tester can move on to the next item.
import type { FocusSweep } from './camera'
import type { Engine, TextRead } from './ocr/engine'
import {
  focusSharpness,
  frameRegion,
  grab,
  logFrame,
  processedCopy,
  sharpnessOf,
  type FrameLog,
  wholeReads,
  type Focuser,
  type ScanProgress,
} from './scanner'
import { levenshtein } from './ocr/vote'
import type { Settings } from './settings'

/** One label: every line read in the box together, top to bottom. */
export interface Capture {
  lines: string[]
  /** Per line: taken from one frame on high confidence (not confirmed by a second frame). */
  fast: boolean[]
  /** Average confidence of the lines' reads. */
  confidence: number
  /** Time since the start of the run when the label was first written down. */
  atMs: number
  /** The label (all its lines and a margin), cut from the frame. */
  crop: HTMLCanvasElement
}

/** A line split into words, each one searchable on its own. */
export const words = (line: string) => line.split(/\s+/).filter(Boolean)

/**
 * What two reads of a line are compared by: case, spaces and the characters the model swaps between
 * frames (letter O and digit 0, I / l and 1) do not count. SN:R4NOLPO28 and SN:R4N0LP028 are one line.
 */
export const key = (t: string) =>
  t
    .replace(/[Il|]/g, '1')
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/\s+/g, '')
const isIdentity = (t: string) => (t.match(/[0-9]/g) ?? []).length >= 4

/**
 * The label's lines in reading order: the order of this frame, with each line not in this frame put
 * back after the line it followed before (a line missing from one frame keeps its place).
 */
export function mergeOrder(before: string[], now: string[]): string[] {
  const out = [...now]
  for (const [i, line] of before.entries()) {
    if (out.includes(line)) continue
    const prev = before.slice(0, i).reverse().find((p) => out.includes(p))
    out.splice(prev === undefined ? 0 : out.indexOf(prev) + 1, 0, line)
  }
  return out
}

/**
 * Whether a label just started is the previous label read again a little differently (the camera
 * wavered, a blurred frame misread a character), rather than a new label. It is when the previous
 * label was seen less than `withinMs` ago, every line of the new one is within 2 characters of a
 * line of the previous one, and every line that differs was taken from a single frame before.
 * Lines confirmed by two frames that differ are kept as a new label: neighbouring serials.
 */
export function isRetake(
  prev: { lines: string[]; fast: boolean[] },
  lines: string[],
  msSinceSeen: number,
  withinMs = 1500,
): boolean {
  if (msSinceSeen > withinMs) return false
  return lines.every((line) => {
    const k = key(line)
    const i = prev.lines.findIndex((p) => key(p) === k)
    if (i >= 0) return true
    const near = prev.lines.findIndex((p) => levenshtein(key(p), k) <= 2)
    return near >= 0 && prev.fast[near]
  })
}

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
 * - a new number of 4+ digits appears and none of the label's own numbers is still in view (same
 *   kind of label, different serial).
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

  /** Lines taken from a single frame because they were read with high confidence. */
  fast = new Set<string>()

  /**
   * The lines of one frame, in reading order. A line read with at least `fastConfidence` counts at
   * once, without waiting for another frame to agree.
   */
  feed(lines: (string | { text: string; confidence: number })[], fastConfidence = 2): TrackerUpdate {
    const items = lines.map((l) => (typeof l === 'string' ? { text: l, confidence: 0 } : l))
    const keys = items.map((l) => key(l.text)).filter((k) => k.length > 0)
    const sure = new Set(items.filter((l) => l.confidence >= fastConfidence).map((l) => key(l.text)))
    this.recent.push(new Set(keys))
    if (this.recent.length > this.window) this.recent.shift()
    const seen = (k: string) => this.recent.filter((f) => f.has(k)).length
    const steady = keys.filter((k, i) => keys.indexOf(k) === i && (seen(k) >= this.need || sure.has(k)))
    for (const k of steady) if (seen(k) < this.need) this.fast.add(k)
    if (!steady.length) {
      if (++this.emptyFrames >= this.gap) this.current = null
      return { started: false, added: [] }
    }
    this.emptyFrames = 0
    const cur = this.current
    const known = cur ? steady.filter((k) => cur.includes(k)).length : 0
    // A new number while none of the label's numbers is in view any more: the next label.
    const newIdentity =
      cur !== null &&
      cur.some(isIdentity) &&
      steady.some((k) => isIdentity(k) && !cur.includes(k)) &&
      !steady.some((k) => isIdentity(k) && cur.includes(k))
    if (!cur || known < steady.length / 2 || newIdentity) {
      this.current = steady
      // Lines seen before the switch must be seen again to count for the new label.
      this.recent = [new Set(keys)]
      return { started: true, added: steady }
    }
    const added = steady.filter((k) => !cur.includes(k))
    if (added.length) this.current = mergeOrder(cur, steady)
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
  /** Labels read again a little differently and merged into the one before. */
  merged: number
  last: HTMLCanvasElement | null
  framesRead: number
  framesBlurry: number
  sharpness: number
  sweeps: (FocusSweep & { at: number })[]
  frameLog: FrameLog[]
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
  onFocus?: (f: FocusSweep) => void,
): Promise<ContinuousResult> {
  const start = performance.now()
  const tracker = new LabelTracker(s.voting ? 2 : 1)
  /** When a label was last in view, and how many retakes were merged into the label before. */
  let lastSeen = -Infinity
  let merged = 0
  const captures: Capture[] = []
  const sweeps: (FocusSweep & { at: number })[] = []
  const frameLog: FrameLog[] = []
  const measure = () => focusSharpness(video, s)
  const sweep = async (force = false) => {
    const at = Math.round(performance.now() - start)
    const r = focuser ? await focuser(measure, force) : null
    if (r) {
      sweeps.push({ ...r, at })
      onFocus?.(r)
    }
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
    const t = Math.round(performance.now() - start)
    if (sharp < s.blurThreshold) {
      logFrame(frameLog, { t, sharp: Math.round(sharp), blurry: true })
      framesBlurry++
      onProgress({ sharpness: sharp, framesRead, framesBlurry, lastReads: [], region, scale: frame.width / region.w })
      // Moving to the next item blurs the picture: look for the focus again (no limit here).
      if (s.focusSweep && ++blurryInARow >= 2) {
        blurryInARow = 0
        await sweep(true)
      }
      await new Promise((r) => setTimeout(r, 30))
      continue
    }
    blurryInARow = 0
    const tPre = performance.now()
    const input = s.preprocess ? processedCopy(frame) : frame
    const preMs = Math.round(performance.now() - tPre)
    const allReads = await engine.read(input, {
      detLimit: s.detLimit,
      minConfidence: s.minConfidence,
      maxBoxes: 12,
    })
    const reads = wholeReads(allReads, frame.width, s.aimBox)
    const cut = allReads.filter((r) => !reads.includes(r)).map((r) => r.text)
    framesRead++
    sharpSum += sharp
    logFrame(frameLog, { t, sharp: Math.round(sharp), blurry: false, preMs, ...engine.last, reads: reads.map((r) => r.text), cut })
    onProgress({ sharpness: sharp, framesRead, framesBlurry, lastReads: reads, region, scale: frame.width / region.w })
    const update = tracker.feed(reads, s.fastConfidence)
    if (tracker.current) lastSeen = performance.now()
    if (update.added.length && tracker.current) {
      const lines = tracker.current
      const inLabel = reads.filter((r) => lines.includes(key(r.text)))
      // Show each line as it was read (not the upper-case key used for comparing).
      const shown = lines.map((k) => reads.find((r) => key(r.text) === k)?.text ?? k)
      const confidence = inLabel.reduce((a, r) => a + r.confidence, 0) / Math.max(1, inLabel.length)
      const crop = cropAround(frame, inLabel.length ? inLabel : reads)
      const prev = captures[captures.length - 1]
      if (update.started && prev && isRetake(prev, shown, performance.now() - lastSeen)) {
        // The previous label read again: keep one label, with the more confident read.
        merged++
        if (confidence > prev.confidence) {
          prev.lines = shown
          prev.fast = lines.map((k) => tracker.fast.has(k))
          prev.confidence = confidence
          prev.crop = crop
        }
        onCapture(prev, false)
      } else if (update.started) {
        const fast = lines.map((k) => tracker.fast.has(k))
        const c: Capture = { lines: shown, fast, confidence, atMs: Math.round(performance.now() - start), crop }
        captures.push(c)
        onCapture(c, true)
      } else {
        const c = captures[captures.length - 1]
        c.lines = shown
        c.fast = lines.map((k) => tracker.fast.has(k))
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
    merged,
    last,
    framesRead,
    framesBlurry,
    sharpness: framesRead ? Math.round(sharpSum / framesRead) : 0,
    sweeps,
    frameLog,
    durationMs: Math.round(performance.now() - start),
  }
}
