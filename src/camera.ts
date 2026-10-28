// Back camera with the controls the phone offers (torch, zoom, focus, exposure). iOS Safari
// offers almost none of them; the app then relies on software preprocessing.

/* The media-capture-image extensions are not in the TypeScript DOM types. */
export interface CameraCaps {
  torch?: boolean
  zoom?: { min: number; max: number; step: number }
  focusMode?: string[]
  exposureMode?: string[]
  exposureCompensation?: { min: number; max: number; step: number }
  sharpness?: { min: number; max: number; step: number }
  contrast?: { min: number; max: number; step: number }
  focusDistance?: { min: number; max: number; step: number }
}

export interface CameraChoice {
  deviceId: string
  label: string
  back: boolean
  /** The closest the camera can focus, in metres; null when the phone does not say. */
  minFocus: number | null
}

/**
 * Can this device scan at all: a touch screen and a camera? Checked before anything is downloaded
 * (no camera permission needed: cameras are listed, without names, before permission).
 */
export async function canScan(): Promise<{ touch: boolean; camera: boolean }> {
  const touch = navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse)').matches
  let camera = false
  try {
    camera = (await navigator.mediaDevices?.enumerateDevices())?.some((d) => d.kind === 'videoinput') ?? false
  } catch {
    camera = false
  }
  return { touch, camera }
}

const stopAll = (s: MediaStream) => s.getTracks().forEach((t) => t.stop())

/**
 * Opens every camera for a moment to learn which way it faces and how close it focuses.
 * Camera names and ids are only given after permission, so one camera is opened first.
 */
export async function probeCameras(): Promise<CameraChoice[]> {
  stopAll(await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } }))
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput')
  const out: CameraChoice[] = []
  for (const [i, d] of devices.entries()) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: d.deviceId } } })
      const t = stream.getVideoTracks()[0]
      const caps = capabilities(t) as CameraCaps & { facingMode?: string[] }
      const facing = t.getSettings().facingMode
      stopAll(stream)
      out.push({
        deviceId: d.deviceId,
        label: d.label || `camera ${i + 1}`,
        back: facing === 'environment' || !!caps.facingMode?.includes('environment') || /back|rear|environment/i.test(d.label),
        minFocus: caps.focusDistance && caps.focusDistance.min > 0 ? caps.focusDistance.min : null,
      })
    } catch {
      // A camera that will not open (busy, or not allowed) is left out.
    }
  }
  return out
}

/** The back camera that focuses closest; '' (the default back camera) when no camera says. */
export function closestFocusing(cameras: CameraChoice[]): string {
  const known = cameras.filter((c) => c.back && c.minFocus !== null)
  if (!known.length) return ''
  return known.reduce((a, b) => (b.minFocus! < a.minFocus! ? b : a)).deviceId
}

const PROBE_KEY = 'camera-probe'

export function cachedProbe(): CameraChoice[] | null {
  try {
    return JSON.parse(localStorage.getItem(PROBE_KEY) ?? 'null')
  } catch {
    return null
  }
}

export function saveProbe(cameras: CameraChoice[] | null) {
  if (cameras) localStorage.setItem(PROBE_KEY, JSON.stringify(cameras))
  else localStorage.removeItem(PROBE_KEY)
}

/** `height` is the short side asked for (1080, 1440, 2160); the phone may give less. */
export async function openCamera(video: HTMLVideoElement, deviceId: string, height: number): Promise<MediaStreamTrack> {
  // The camera can still be held for a moment by a page that just closed it (or reloaded):
  // "Could not start video source". Try again a few times before giving up.
  for (let attempt = 1; ; attempt++) {
    try {
      return await openOnce(video, deviceId, height)
    } catch (e) {
      if ((e as Error).name !== 'NotReadableError' || attempt >= 4) throw e
      await new Promise((r) => setTimeout(r, 600 * attempt))
    }
  }
}

async function openOnce(video: HTMLVideoElement, deviceId: string, height: number): Promise<MediaStreamTrack> {
  const width = Math.round((height * 16) / 9)
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }),
      width: { ideal: width },
      height: { ideal: height },
    },
  })
  video.srcObject = stream
  video.setAttribute('playsinline', '')
  video.muted = true
  await video.play()
  return stream.getVideoTracks()[0]
}

export function capabilities(track: MediaStreamTrack): CameraCaps {
  return (track.getCapabilities?.() ?? {}) as CameraCaps
}

export function supportedList(caps: CameraCaps): string[] {
  const out: string[] = []
  if (caps.torch) out.push('torch')
  if (caps.zoom) out.push('zoom')
  if (caps.focusMode?.includes('continuous')) out.push('focus')
  if (caps.exposureMode?.includes('continuous')) out.push('exposure')
  if (caps.exposureCompensation) out.push('exposureCompensation')
  if (caps.sharpness) out.push('sharpness')
  if (caps.contrast) out.push('contrast')
  if (caps.focusDistance && caps.focusMode?.includes('manual')) out.push('manualFocus')
  return out
}

async function apply(track: MediaStreamTrack, c: Record<string, unknown>): Promise<boolean> {
  try {
    await track.applyConstraints({ advanced: [c as MediaTrackConstraintSet] })
    return true
  } catch {
    return false
  }
}

export function setTorch(track: MediaStreamTrack, on: boolean) {
  return apply(track, { torch: on })
}


/** A focus distance in metres, or null for continuous autofocus. */
export async function setFocus(track: MediaStreamTrack, distance: number | null) {
  if (distance === null) return apply(track, { focusMode: 'continuous' })
  return apply(track, { focusMode: 'manual', focusDistance: distance })
}

export function canSweepFocus(caps: CameraCaps): boolean {
  return !!caps.focusDistance && !!caps.focusMode?.includes('manual')
}

export interface FocusSweep {
  distance: number
  sharpness: number
  ms: number
  /** kept: still sharp where it was; climb: from the last good focus; sweep: whole range (first). */
  kind: 'kept' | 'climb' | 'sweep'
  /** The scanning range used (metres): the closest the camera focuses, and the far end. */
  near: number
  far: number
  /** [distance, sharpness] of every step, for studying later. */
  samples: [number, number][]
}

/** The scanning distance in metres: 3 to 10 cm, or from the closest the camera can focus. */
export function focusRange(caps: CameraCaps): { near: number; far: number } | null {
  if (!caps.focusDistance || !canSweepFocus(caps)) return null
  const near = Math.max(caps.focusDistance.min, 0.03)
  const far = Math.min(Math.max(0.1, near * 1.5), caps.focusDistance.max)
  return far > near ? { near, far } : null
}

/**
 * Moves the lens to the sharpest picture. Works in dioptres (1 / distance), where the picture's
 * sharpness changes evenly. The first search sweeps the range in 6 steps; after that, each search
 * first checks the last good focus and stops there if the picture is still nearly as sharp;
 * otherwise it climbs from there: one step one way, keep going while it gets sharper, else try
 * the other way, then halve the step, down to a sixteenth of the range. After each move it
 * waits for the next camera frame(s) before measuring.
 */
export class FocusSearch {
  private track: MediaStreamTrack
  private waitFrame: () => Promise<void>
  private settleFrames: number
  /** Last good focus, its sharpness, and the way the last climb went. */
  private last: number | null = null
  private lastSharp = 0
  private dir = 1

  constructor(track: MediaStreamTrack, waitFrame: () => Promise<void>, settleFrames = 1) {
    this.track = track
    this.waitFrame = waitFrame
    this.settleFrames = settleFrames
  }

  /** `force`: the picture is known to be blurred, so the last focus is not kept without a search. */
  async find(measure: () => number, force = false): Promise<FocusSweep | null> {
    const range = focusRange(capabilities(this.track))
    if (!range) return null
    const t0 = performance.now()
    const lo = 1 / range.far
    const hi = 1 / range.near
    const span = hi - lo
    const samples: [number, number][] = []
    const seen = new Map<number, number>()
    const at = async (dioptre: number) => {
      const d = Math.round(Math.min(hi, Math.max(lo, dioptre)) * 100) / 100
      const known = seen.get(d)
      if (known !== undefined) return { d, s: known }
      if (!(await setFocus(this.track, 1 / d))) return { d, s: -1 }
      for (let i = 0; i < this.settleFrames; i++) await this.waitFrame()
      const sharp = measure()
      seen.set(d, sharp)
      samples.push([Math.round(1000 / d) / 1000, Math.round(sharp)])
      return { d, s: sharp }
    }

    const kind = this.last === null ? 'sweep' : 'climb'
    let best = { d: lo, s: -1 }
    if (this.last === null) {
      for (let i = 0; i <= 5; i++) {
        const r = await at(hi - (i * span) / 5)
        if (r.s > best.s) best = r
      }
    } else {
      best = await at(this.last)
      // Still nearly as sharp as when it was found: nothing to search.
      if (!force && best.s >= 0.85 * this.lastSharp) {
        return {
          distance: Math.round(1000 / best.d) / 1000,
          sharpness: Math.round(best.s),
          ms: Math.round(performance.now() - t0),
          kind: 'kept',
          near: range.near,
          far: range.far,
          samples,
        }
      }
    }
    let step = kind === 'sweep' ? span / 10 : span / 4
    while (step >= span / 16) {
      for (const dir of [this.dir, -this.dir]) {
        let r = await at(best.d + dir * step)
        if (r.s <= best.s) continue
        // Sharper this way: keep going while it improves.
        this.dir = dir
        while (r.s > best.s) {
          best = r
          if (best.d <= lo || best.d >= hi) break
          r = await at(best.d + dir * step)
        }
        break
      }
      step /= 2
    }
    await setFocus(this.track, 1 / best.d)
    this.last = best.d
    this.lastSharp = best.s
    return {
      distance: Math.round(1000 / best.d) / 1000,
      sharpness: Math.round(best.s),
      ms: Math.round(performance.now() - t0),
      kind,
      near: range.near,
      far: range.far,
      samples,
    }
  }
}

/**
 * "Hardware controls on": continuous focus and exposure, the given exposure compensation,
 * the highest sharpness and a raised contrast, each only where the phone supports it.
 */
export async function setHardware(track: MediaStreamTrack, on: boolean, exposureComp: number): Promise<string[]> {
  if (!on) return []
  const caps = capabilities(track)
  const applied: string[] = []
  if (caps.focusMode?.includes('continuous') && (await apply(track, { focusMode: 'continuous' }))) applied.push('focus')
  if (caps.exposureMode?.includes('continuous') && (await apply(track, { exposureMode: 'continuous' }))) applied.push('exposure')
  if (caps.exposureCompensation) {
    const v = Math.max(caps.exposureCompensation.min, Math.min(caps.exposureCompensation.max, exposureComp))
    if (await apply(track, { exposureCompensation: v })) applied.push(`exposureCompensation=${v}`)
  }
  if (caps.sharpness && (await apply(track, { sharpness: caps.sharpness.max }))) applied.push('sharpness')
  if (caps.contrast) {
    const v = caps.contrast.min + 0.75 * (caps.contrast.max - caps.contrast.min)
    if (await apply(track, { contrast: v })) applied.push('contrast')
  }
  return applied
}

export function trackResolution(track: MediaStreamTrack): string {
  const s = track.getSettings()
  return `${s.width ?? '?'}x${s.height ?? '?'}`
}
