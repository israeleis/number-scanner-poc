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
}

export async function openCamera(video: HTMLVideoElement): Promise<MediaStreamTrack> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
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

export function setZoom(track: MediaStreamTrack, zoom: number) {
  return apply(track, { zoom })
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
