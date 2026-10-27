import { describe, expect, it } from 'vitest'
import { closestFocusing, sweepFocus, type CameraChoice } from './camera'

/** A stand-in camera track whose picture is sharpest with the lens at `best` metres. */
function fakeTrack(best: number, manual = true) {
  let distance = 1
  const track = {
    getCapabilities: () => ({
      focusMode: manual ? ['continuous', 'manual'] : ['continuous'],
      focusDistance: { min: 0.05, max: 10, step: 0.01 },
    }),
    applyConstraints: async (c: { advanced: { focusDistance?: number }[] }) => {
      const d = c.advanced[0].focusDistance
      if (d !== undefined) distance = d
    },
  } as unknown as MediaStreamTrack
  // Sharpness falls off with the distance in dioptres from the best focus.
  const measure = () => 1000 / (1 + 50 * Math.abs(1 / distance - 1 / best))
  return { track, measure, lens: () => distance }
}

describe('sweepFocus', () => {
  it('finds and locks a close focus', async () => {
    const { track, measure, lens } = fakeTrack(0.12)
    const r = await sweepFocus(track, measure)
    expect(r).not.toBeNull()
    expect(Math.abs(1 / r!.distance - 1 / 0.12)).toBeLessThan(1.5)
    expect(lens()).toBeCloseTo(r!.distance, 2)
    expect(r!.samples.length).toBeGreaterThanOrEqual(7)
  })

  it('finds a farther focus too, up to 30 cm', async () => {
    const { track, measure } = fakeTrack(0.25)
    const r = await sweepFocus(track, measure)
    expect(r!.distance).toBeGreaterThan(0.18)
    expect(r!.distance).toBeLessThanOrEqual(0.3)
  })

  it('does nothing when the phone has no manual focus', async () => {
    const { track, measure } = fakeTrack(0.12, false)
    expect(await sweepFocus(track, measure)).toBeNull()
  })
})

describe('closestFocusing', () => {
  const cam = (deviceId: string, back: boolean, minFocus: number | null): CameraChoice => ({ deviceId, label: deviceId, back, minFocus })

  it('picks the back camera that focuses closest', () => {
    expect(closestFocusing([cam('main', true, 0.1), cam('wide', true, 0.03), cam('front', false, 0.01)])).toBe('wide')
  })

  it('falls back to the default camera when no camera says how close it focuses', () => {
    expect(closestFocusing([cam('main', true, null), cam('wide', true, null)])).toBe('')
  })
})
