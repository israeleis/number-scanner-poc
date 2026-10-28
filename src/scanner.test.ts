import { describe, expect, it } from 'vitest'
import { aimRegion, viewToFrame, wholeReads } from './scanner'

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

describe('wholeReads', () => {
  const r = (text: string, x: number, w: number) => ({ text, box: { x, w } })
  it('leaves out text cut by the left or right side of the box', () => {
    const reads = [r('T7902', 0, 80), r('Contains MT7902', 40, 300), r('MF', 560, 40)]
    expect(wholeReads(reads, 600, true).map((x) => x.text)).toEqual(['Contains MT7902'])
  })
  it('keeps everything with the box off', () => {
    expect(wholeReads([r('T7902', 0, 80)], 600, false)).toHaveLength(1)
  })
})

describe('viewToFrame', () => {
  const video = { videoWidth: 2160, videoHeight: 3840, clientWidth: 390, clientHeight: 300 }

  it('the middle of the viewfinder is the middle of the box', () => {
    const r = aimRegion(2160, 3840, 390, 300, 0.9, 0.85, 2)
    const scale = 1280 / r.w
    const p = viewToFrame(video, 2, r, scale, { fx: 0.5, fy: 0.5 })
    expect(p.x).toBeCloseTo((r.w * scale) / 2)
    expect(p.y).toBeCloseTo((r.h * scale) / 2)
  })

  it('a finger near the left edge lands near the left of the box', () => {
    const r = aimRegion(2160, 3840, 390, 300, 0.9, 0.85, 1)
    const p = viewToFrame(video, 1, r, 1, { fx: 0.1, fy: 0.5 })
    // 10% across the view is 5% of the view inside the box, whose left edge is at 5%.
    expect(p.x).toBeCloseTo((0.05 / 0.9) * r.w, 0)
  })
})
