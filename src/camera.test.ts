import { describe, expect, it } from 'vitest'
import { sweepFocus } from './camera'

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

  it('finds a farther focus too', async () => {
    const { track, measure } = fakeTrack(0.6)
    const r = await sweepFocus(track, measure)
    expect(r!.distance).toBeGreaterThan(0.4)
  })

  it('does nothing when the phone has no manual focus', async () => {
    const { track, measure } = fakeTrack(0.12, false)
    expect(await sweepFocus(track, measure)).toBeNull()
  })
})
