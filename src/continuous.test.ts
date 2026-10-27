import { describe, expect, it } from 'vitest'
import { isRetake, key, LabelTracker, mergeOrder, sameShape, words } from './continuous'

describe('LabelTracker', () => {
  it('starts a label once its lines are read the same way in two recent frames', () => {
    const t = new LabelTracker(2)
    expect(t.feed(['Island Dogs LLC', 'Made in China']).started).toBe(false)
    const u = t.feed(['Island Dogs LLC', 'Made in China'])
    expect(u.started).toBe(true)
    expect(t.current).toEqual([key('Island Dogs LLC'), key('Made in China')])
  })

  it('adds a line that becomes steady later to the same label, without a new start', () => {
    const t = new LabelTracker(2)
    t.feed(['Island Dogs LLC'])
    t.feed(['Island Dogs LLC', 'Tracking No. 2405N22.5'])
    const u = t.feed(['Island Dogs LLC', 'Tracking No. 2405N22.5'])
    expect(u).toEqual({ started: false, added: [key('Tracking No. 2405N22.5')] })
    expect(t.current).toEqual([key('Island Dogs LLC'), key('Tracking No. 2405N22.5')])
  })

  it('a label of the same kind with another serial is a new label', () => {
    const t = new LabelTracker(2)
    t.feed(['M4A1', 'SN A7310592'])
    t.feed(['M4A1', 'SN A7310592'])
    t.feed(['M4A1', 'SN A7310593'])
    const u = t.feed(['M4A1', 'SN A7310593'])
    expect(u.started).toBe(true)
    expect(t.current).toEqual([key('M4A1'), key('SN A7310593')])
  })

  it('moving off the label ends it; coming back starts it again', () => {
    const t = new LabelTracker(2, 4, 3)
    t.feed(['42'])
    t.feed(['42'])
    t.feed([])
    t.feed([])
    t.feed([])
    expect(t.current).toBeNull()
    t.feed(['42'])
    expect(t.feed(['42']).started).toBe(true)
  })

  it('a misread in one frame is not added', () => {
    const t = new LabelTracker(2)
    t.feed(['A7310592'])
    t.feed(['A7310592'])
    expect(t.feed(['A73I0592', 'A7310592']).added).toEqual([])
  })

  it('a line read with high confidence counts at once', () => {
    const t = new LabelTracker(2)
    const u = t.feed([{ text: 'A7310592', confidence: 0.98 }, { text: 'MADE IN', confidence: 0.8 }], 0.95)
    expect(u.started).toBe(true)
    expect(t.current).toEqual([key('A7310592')])
    expect(t.fast.has('A7310592')).toBe(true)
  })

  it('a line below the confidence still waits for a second frame', () => {
    const t = new LabelTracker(2)
    expect(t.feed([{ text: 'A7310592', confidence: 0.9 }], 0.95).started).toBe(false)
    expect(t.feed([{ text: 'A7310592', confidence: 0.9 }], 0.95).started).toBe(true)
    expect(t.fast.has('A7310592')).toBe(false)
  })

  it('without voting one frame is enough', () => {
    expect(new LabelTracker(1).feed(['42']).started).toBe(true)
  })
})

describe('LabelTracker with real reads from the phone', () => {
  it('a serial read with O in one frame and 0 in the next is one steady line', () => {
    const t = new LabelTracker(2)
    t.feed([{ text: 'X1404ZA-NK101', confidence: 0.99 }, { text: 'SN:R4NOLPO28239165', confidence: 0.9 }], 0.97)
    t.feed([{ text: 'X1404ZA-NK101', confidence: 0.99 }, { text: 'SN:R4N0LP028239165', confidence: 0.9 }], 0.97)
    expect(t.current).toContain(key('SN:R4N0LP028239165'))
  })

  it('more lines of the same label coming into view (one with a date) do not start a new label', () => {
    const t = new LabelTracker(2)
    t.feed([{ text: 'X1404ZA-NK101', confidence: 0.99 }, { text: '12M', confidence: 0.99 }], 0.97)
    const u = t.feed(
      ['X1404ZA-NK101', 'CN:MNN2', 'MFD:2023-04', '12M'].map((text) => ({ text, confidence: 0.99 })),
      0.97,
    )
    expect(u.started).toBe(false)
    expect(u.added).toEqual([key('CN:MNN2'), key('MFD:2023-04')])
  })
})

describe('LabelTracker with lines read in pieces', () => {
  const feed = (t: LabelTracker, lines: string[]) => t.feed(lines.map((text) => ({ text, confidence: 0.99 })), 0.97)

  it('pieces of the label\'s lines do not start a new label or add lines', () => {
    const t = new LabelTracker(2)
    feed(t, ['X1404ZA-NK101', 'SN:R4N0LP028239165', 'CN:MNN2', 'MFD:2023-04', '12M'])
    const u = feed(t, ['X1404ZA-', '-NK101', ':R4NOLPO28239165', 'CN : MNN2', 'MFD:2023-', '-04', '12M'])
    expect(u.started).toBe(false)
    expect(u.added).toEqual([])
    expect(t.current).toHaveLength(5)
  })

  it('a longer read of a line replaces the shorter one', () => {
    const t = new LabelTracker(2)
    feed(t, ['X1404ZA-NK', 'CN:MNN2'])
    feed(t, ['X1404ZA-NK101', 'CN:MNN2'])
    expect(t.current).toEqual([key('X1404ZA-NK101'), key('CN:MNN2')])
  })
})

describe('LabelTracker while the phone moves along one label', () => {
  it('a date coming into view as the serial leaves is the same label', () => {
    const t = new LabelTracker(2)
    const feed = (lines: string[]) => t.feed(lines.map((text) => ({ text, confidence: 0.99 })), 0.97)
    feed(['X1404ZA-NK101', '12M'])
    expect(feed(['MFD:2023-04', '12M']).started).toBe(false)
    expect(t.current).toContain(key('MFD:2023-04'))
  })

  it('serials of one shape are told apart, a date is another shape', () => {
    expect(sameShape(key('SN A7310592'), key('SN A7310593'))).toBe(true)
    expect(sameShape(key('X1404ZA-NK101'), key('MFD:2023-04'))).toBe(false)
  })
})

describe('words', () => {
  it('splits a line into its words', () => {
    expect(words('Tracking No.  2405N22.5')).toEqual(['Tracking', 'No.', '2405N22.5'])
  })
})

describe('mergeOrder', () => {
  it('a line missing from this frame keeps its place', () => {
    expect(mergeOrder(['CONTAINS', 'FCC ID', 'IC'], ['CONTAINS', 'IC', 'R-C'])).toEqual(['CONTAINS', 'FCC ID', 'IC', 'R-C'])
  })
  it('a first line missing from this frame stays first', () => {
    expect(mergeOrder(['A', 'B'], ['B', 'C'])).toEqual(['A', 'B', 'C'])
  })
})

describe('isRetake', () => {
  const prev = { lines: ['1290103707569'], fast: [true] }

  it('a label read again within a moment, one character off a one-frame read, is the same label', () => {
    expect(isRetake(prev, ['7290103707569'], 700)).toBe(true)
  })

  it('not after the moment has passed', () => {
    expect(isRetake(prev, ['7290103707569'], 3000)).toBe(false)
  })

  it('neighbouring serials both confirmed by two frames stay two labels', () => {
    expect(isRetake({ lines: ['A7310592'], fast: [false] }, ['A7310593'], 500)).toBe(false)
  })

  it('a really different label is not a retake', () => {
    expect(isRetake({ lines: ['SPARK'], fast: [true] }, ['MIDEA'], 500)).toBe(false)
  })

  it('the same lines again are a retake', () => {
    expect(isRetake({ lines: ['RARE', 'X1'], fast: [false, false] }, ['RARE'], 500)).toBe(true)
  })
})
