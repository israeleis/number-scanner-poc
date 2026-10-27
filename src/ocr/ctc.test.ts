import { describe, expect, it } from 'vitest'
import { ctcDecode } from './ctc'
import { boxCorners, dbBoxes } from './engine'
import { laplacianVariance, preprocess } from './imageops'

describe('ctcDecode', () => {
  it('collapses repeats and drops blanks', () => {
    const dict = ['1', '2']
    // steps: 1, 1, blank, 1, 2  ->  "112"
    const rows = [
      [0.1, 0.8, 0.1],
      [0.1, 0.8, 0.1],
      [0.9, 0.05, 0.05],
      [0.1, 0.7, 0.2],
      [0.1, 0.1, 0.8],
    ]
    const out = ctcDecode(rows.flat(), rows.length, 3, dict)
    expect(out.text).toBe('112')
    expect(out.charConf).toHaveLength(3)
  })
})

describe('dbBoxes', () => {
  it('finds one box per text region and grows it', () => {
    const w = 40
    const h = 20
    const prob = new Float32Array(w * h)
    for (let y = 5; y < 10; y++) for (let x = 5; x < 20; x++) prob[y * w + x] = 0.9
    for (let y = 12; y < 16; y++) for (let x = 25; x < 35; x++) prob[y * w + x] = 0.9
    const boxes = dbBoxes(prob, w, h)
    expect(boxes).toHaveLength(2)
    expect(boxes[0].x).toBeLessThan(5)
    expect(boxes[0].w).toBeGreaterThan(15)
    expect(boxes[0].angle).toBeCloseTo(0, 5)
  })

  it('turns the box with slanted text', () => {
    const w = 60
    const h = 60
    const prob = new Float32Array(w * h)
    // A band 4 pixels thick along the diagonal, 45 degrees down to the right.
    for (let t = 5; t < 50; t++) for (let k = -2; k < 2; k++) prob[(t + k) * w + t] = 0.9
    const [box] = dbBoxes(prob, w, h)
    expect((box.angle * 180) / Math.PI).toBeCloseTo(45, -1)
    expect(box.length).toBeGreaterThan(4 * box.thickness)
  })

  it('a vertical band gets a quarter turn and scales to image pixels', () => {
    const w = 20
    const h = 60
    const prob = new Float32Array(w * h)
    for (let y = 5; y < 50; y++) for (let x = 8; x < 12; x++) prob[y * w + x] = 0.9
    const [box] = dbBoxes(prob, w, h, 2, 2)
    expect(Math.abs((box.angle * 180) / Math.PI)).toBeCloseTo(90, 0)
    expect(box.cx).toBeCloseTo(20, 0)
    expect(box.length).toBeGreaterThan(90)
  })
})

describe('imageops', () => {
  it('a flat image has no sharpness, an edge has some', () => {
    const flat = new Float32Array(100).fill(128)
    expect(laplacianVariance(flat, 10, 10)).toBe(0)
    const edge = new Float32Array(100).map((_, i) => (i % 10 < 5 ? 0 : 255))
    expect(laplacianVariance(edge, 10, 10)).toBeGreaterThan(100)
  })

  it('stretches a low-contrast image to the full range', () => {
    const data = new Uint8ClampedArray(4 * 100)
    for (let i = 0; i < 100; i++) {
      const v = i < 50 ? 100 : 140
      data.set([v, v, v, 255], i * 4)
    }
    const img = { data, width: 10, height: 10, colorSpace: 'srgb' } as ImageData
    preprocess(img)
    expect(data[0]).toBeLessThan(20)
    expect(data[99 * 4]).toBeGreaterThan(235)
  })
})

describe('boxCorners', () => {
  it('an upright box has its corners around the centre', () => {
    expect(boxCorners({ cx: 10, cy: 5, length: 8, thickness: 2, angle: 0 })).toEqual([
      [6, 4],
      [14, 4],
      [14, 6],
      [6, 6],
    ])
  })
})
