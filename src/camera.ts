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
  /** [distance, sharpness] of every step, for studying later. */
  samples: [number, number][]
}

const settle = () => new Promise((r) => setTimeout(r, 90))

/**
 * Finds the sharpest focus by moving the lens and measuring: 7 steps from the nearest the lens
 * can focus (4 cm at the nearest) out to 20 cm, where labels are scanned, then 4 steps around the
 * best one, then locks there. Steps are even in dioptres (1 / distance), so most are close up.
 */
export async function sweepFocus(track: MediaStreamTrack, measure: () => number): Promise<FocusSweep | null> {
  const caps = capabilities(track)
  if (!caps.focusDistance || !canSweepFocus(caps)) return null
  const t0 = performance.now()
  const near = Math.max(caps.focusDistance.min, 0.04)
  const far = Math.max(near * 1.5, Math.min(caps.focusDistance.max, 0.2))
  const samples: [number, number][] = []
  const at = async (dioptre: number) => {
    const d = Math.min(far, Math.max(near, 1 / dioptre))
    if (!(await setFocus(track, d))) return -1
    await settle()
    const s = measure()
    samples.push([Math.round(d * 1000) / 1000, Math.round(s)])
    return s
  }
  const dNear = 1 / near
  const dFar = 1 / far
  const step = (dNear - dFar) / 6
  let best = { dioptre: dNear, sharp: -1 }
  for (let i = 0; i <= 6; i++) {
    const dioptre = dNear - i * step
    const sharp = await at(dioptre)
    if (sharp > best.sharp) best = { dioptre, sharp }
  }
  for (const off of [-0.5, -0.25, 0.25, 0.5]) {
    const dioptre = best.dioptre + off * step
    if (dioptre > dNear || dioptre < dFar) continue
    const sharp = await at(dioptre)
    if (sharp > best.sharp) best = { dioptre, sharp }
  }
  const distance = Math.min(far, Math.max(near, 1 / best.dioptre))
  await setFocus(track, distance)
  await settle()
  return { distance: Math.round(distance * 1000) / 1000, sharpness: Math.round(best.sharp), ms: Math.round(performance.now() - t0), samples }
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
