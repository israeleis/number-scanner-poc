import { describe, expect, it } from 'vitest'
import { cleanDigits, ctcDecode } from './ctc'
import { boxCorners, chooseBoxes, dbBoxes, distanceToBox, inTextOrder, joinLineParts } from './engine'
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

describe('inTextOrder', () => {
  const read = (text: string, cx: number, cy: number, deg: number) => ({
    text,
    rotation: deg,
    box: { cx, cy, thickness: 20, angle: (deg * Math.PI) / 180, length: 200, x: 0, y: 0, w: 0, h: 0, score: 1 },
  })
  // A label turned 20 degrees: each next line is 30 px further across the text.
  const place = (deg: number, line: number, along: number) => {
    const a = (deg * Math.PI) / 180
    return [300 + along * Math.cos(a) - line * 30 * Math.sin(a), 300 + along * Math.sin(a) + line * 30 * Math.cos(a)] as const
  }

  it('orders the lines of a slanted label as they read, not by height on the screen', () => {
    const lines = ['Contains MT7902', 'FCC ID RAS-MT7902', 'IC 7542A-MT7902', 'R-C-MD6']
    // Lines start at different places along the text, as on the real label.
    const reads = lines.map((t, i) => read(t, ...place(20, i, [40, 80, -60, 0][i]), 20))
    expect(inTextOrder([...reads].reverse()).map((r) => r.text)).toEqual(lines)
  })

  it('upside-down text reads from the bottom of the screen up', () => {
    const top = read('second', 300, 100, 180)
    const bottom = read('first', 300, 200, 180)
    expect(inTextOrder([top, bottom]).map((r) => r.text)).toEqual(['first', 'second'])
  })

  it('two words on one row read left to right', () => {
    expect(inTextOrder([read('B', 300, 101, 0), read('A', 100, 100, 0)]).map((r) => r.text)).toEqual(['A', 'B'])
  })
})

describe('cleanDigits', () => {
  it('drops quote marks a barcode leaves inside its digits', () => {
    expect(cleanDigits('290019"603498')).toBe('290019603498')
    expect(cleanDigits("'290019603498")).toBe('290019603498')
  })
  it('leaves words with few digits alone', () => {
    expect(cleanDigits('O\'Neil 12" pipe')).toBe('O\'Neil 12" pipe')
  })
})

describe('joinLineParts', () => {
  const box = (cx: number, cy: number, length: number, thickness = 20, angle = 0) => ({
    cx, cy, length, thickness, angle, x: cx - length / 2, y: cy - thickness / 2, w: length, h: thickness, score: 0.9,
  })

  it('joins two pieces of one line split at a hyphen', () => {
    const out = joinLineParts([box(100, 50, 100), box(195, 52, 100)])
    expect(out).toHaveLength(1)
    expect(out[0].length).toBeCloseTo(195, 0)
  })

  it('keeps apart two columns half a line apart, and lines above each other', () => {
    expect(joinLineParts([box(100, 50, 100), box(210, 50, 100)])).toHaveLength(2)
    expect(joinLineParts([box(100, 50, 100), box(100, 80, 100)])).toHaveLength(2)
  })

  it('joins pieces of a slanted line', () => {
    const a = Math.PI / 6
    const p = (d: number) => box(200 + d * Math.cos(a), 200 + d * Math.sin(a), 90, 20, a)
    expect(joinLineParts([p(-43), p(43)])).toHaveLength(1)
  })
})

describe('distanceToBox', () => {
  const b = { cx: 100, cy: 50, length: 100, thickness: 20, angle: 0 }
  it('is 0 inside the box, and the gap outside it', () => {
    expect(distanceToBox({ x: 120, y: 55 }, b)).toBe(0)
    expect(distanceToBox({ x: 100, y: 90 }, b)).toBe(30)
    expect(distanceToBox({ x: 160, y: 50 }, b)).toBe(10)
  })
  it('follows a turned box', () => {
    const turned = { ...b, angle: Math.PI / 2 }
    expect(distanceToBox({ x: 100, y: 140 }, turned)).toBeCloseTo(40)
  })
})

describe('chooseBoxes', () => {
  const box = (cy: number, length = 100) => ({ cx: 100, cy, length, thickness: 20, angle: 0, w: length, h: 20 })
  const boxes = [box(20, 300), box(100), box(130)]
  const focus = { x: 100, y: 105 }

  it('reads everything, nearest the middle first', () => {
    expect(chooseBoxes(boxes, { focus, maxBoxes: 12 }).map((b) => b.cy)).toEqual([100, 130, 20])
  })

  it('precision reads only the line under the crosshair', () => {
    expect(chooseBoxes(boxes, { focus, maxBoxes: 12, onlyAtFocus: true }).map((b) => b.cy)).toEqual([100])
  })

  it('precision reads nothing when no line is near the crosshair', () => {
    expect(chooseBoxes(boxes, { focus: { x: 100, y: 400 }, maxBoxes: 12, onlyAtFocus: true })).toEqual([])
  })
})
