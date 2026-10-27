import { describe, expect, it } from 'vitest'
import { closestFocusing, FocusSearch, type CameraChoice } from './camera'

/** A stand-in camera track whose picture is sharpest with the lens at `best` metres. */
function fakeTrack(bestAt: number, manual = true) {
  let best = bestAt
  let distance = 1
  const track = {
    getCapabilities: () => ({
      focusMode: manual ? ['continuous', 'manual'] : ['continuous'],
      focusDistance: { min: 0.02, max: 10, step: 0.001 },
    }),
    applyConstraints: async (c: { advanced: { focusDistance?: number }[] }) => {
      const d = c.advanced[0].focusDistance
      if (d !== undefined) distance = d
    },
  } as unknown as MediaStreamTrack
  // Sharpness falls off with the distance in dioptres from the best focus.
  const measure = () => 1000 / (1 + 50 * Math.abs(1 / distance - 1 / best))
  return { track, measure, lens: () => distance, setBest: (b: number) => void (best = b) }
}

describe('FocusSearch', () => {
  const noWait = async () => {}

  it('finds and locks a close focus on the first search', async () => {
    const { track, measure, lens } = fakeTrack(0.05)
    const r = await new FocusSearch(track, noWait).find(measure)
    expect(r!.kind).toBe('sweep')
    expect(Math.abs(1 / r!.distance - 1 / 0.05)).toBeLessThan(1)
    expect(lens()).toBeCloseTo(r!.distance, 2)
  })

  it('later searches climb from the last focus with few steps', async () => {
    const cam = fakeTrack(0.05)
    const search = new FocusSearch(cam.track, noWait)
    await search.find(cam.measure)
    cam.setBest(0.06)
    const r = await search.find(cam.measure)
    expect(r!.kind).toBe('climb')
    expect(Math.abs(1 / r!.distance - 1 / 0.06)).toBeLessThan(1)
    expect(r!.samples.length).toBeLessThanOrEqual(10)
  })

  it('does not search again while the picture is still sharp', async () => {
    const cam = fakeTrack(0.05)
    const search = new FocusSearch(cam.track, noWait)
    await search.find(cam.measure)
    const r = await search.find(cam.measure)
    expect(r!.kind).toBe('kept')
    expect(r!.samples.length).toBe(1)
  })

  it('searches when told the picture is blurred, even if it looks as sharp as before', async () => {
    const cam = fakeTrack(0.05)
    const search = new FocusSearch(cam.track, noWait)
    await search.find(cam.measure)
    expect((await search.find(cam.measure, true))!.kind).toBe('climb')
  })

  it('stays within 3 to 10 cm', async () => {
    const cam = fakeTrack(0.5)
    const r = await new FocusSearch(cam.track, noWait).find(cam.measure)
    expect(r!.distance).toBeLessThanOrEqual(0.1)
    expect(r!.distance).toBeGreaterThan(0.08)
  })

  it('waits the given number of camera frames after each move', async () => {
    const cam = fakeTrack(0.05)
    let frames = 0
    const r = await new FocusSearch(cam.track, async () => void frames++, 2).find(cam.measure)
    expect(frames).toBe(2 * r!.samples.length)
  })

  it('does nothing when the phone has no manual focus', async () => {
    const { track, measure } = fakeTrack(0.05, false)
    expect(await new FocusSearch(track, noWait).find(measure)).toBeNull()
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
