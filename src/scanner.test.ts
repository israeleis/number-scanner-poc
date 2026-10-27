import { describe, expect, it } from 'vitest'
import { aimRegion } from './scanner'

describe('aimRegion', () => {
  it('a portrait video in a portrait box that fits exactly: the middle share of the whole picture', () => {
    expect(aimRegion(1080, 1920, 300, 533.33, 0.8, 0.3)).toEqual(
      expect.objectContaining({ x: expect.closeTo(108, 0), w: expect.closeTo(864, 0), h: expect.closeTo(576, 0) }),
    )
  })

  it('a landscape video cropped into a 3:4 box: the box is within the visible middle', () => {
    const r = aimRegion(1920, 1080, 300, 400, 0.8, 0.3)
    // Visible part: 810 wide (1080 * 3 / 4), all 1080 high.
    expect(r.w).toBeCloseTo(648)
    expect(r.h).toBeCloseTo(324)
    expect(r.x).toBeCloseTo((1920 - 648) / 2)
    expect(r.y).toBeCloseTo((1080 - 324) / 2)
  })
})

describe('aimRegion with magnification', () => {
  it('magnifying twice halves the region around the centre', () => {
    const a = aimRegion(1920, 1080, 300, 400, 0.8, 0.3, 1)
    const b = aimRegion(1920, 1080, 300, 400, 0.8, 0.3, 2)
    expect(b.w).toBeCloseTo(a.w / 2)
    expect(b.h).toBeCloseTo(a.h / 2)
    expect(b.x + b.w / 2).toBeCloseTo(960)
    expect(b.y + b.h / 2).toBeCloseTo(540)
  })
})

describe('aimRegion in the strip viewfinder', () => {
  it('a portrait 4K video in a 1.3:1 viewfinder: the box spans most of the width, about 1.4:1', () => {
    const r = aimRegion(2160, 3840, 390, 300, 0.9, 0.85)
    expect(r.w).toBeCloseTo(2160 * 0.9)
    expect(r.w / r.h).toBeCloseTo(1.38, 1)
  })
})
