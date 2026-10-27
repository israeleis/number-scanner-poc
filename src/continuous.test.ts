import { describe, expect, it } from 'vitest'
import { Collector } from './continuous'

describe('Collector', () => {
  it('writes a text down once it is read the same way in two recent frames', () => {
    const c = new Collector(2)
    expect(c.feed(['A7310592'])).toEqual([])
    expect(c.feed(['A7310592'])).toEqual(['A7310592'])
  })

  it('writes the same text down only once', () => {
    const c = new Collector(2)
    c.feed(['A7310592'])
    c.feed(['A7310592'])
    expect(c.feed(['A7310592'])).toEqual([])
  })

  it('keeps neighbouring serials apart', () => {
    const c = new Collector(2)
    c.feed(['A7310592'])
    c.feed(['A7310592', 'A7310593'])
    expect(c.feed(['A7310593'])).toEqual(['A7310593'])
  })

  it('ignores a misread seen in one frame only', () => {
    const c = new Collector(2)
    c.feed(['A7310592'])
    c.feed(['A73I0592'])
    expect(c.feed(['B000'])).toEqual([])
  })

  it('forgets reads older than the window', () => {
    const c = new Collector(2, 3)
    c.feed(['X1'])
    c.feed([])
    c.feed([])
    c.feed([])
    expect(c.feed(['X1'])).toEqual([])
  })

  it('without voting one frame is enough', () => {
    expect(new Collector(1).feed(['42'])).toEqual(['42'])
  })

  it('treats case and spacing the same', () => {
    const c = new Collector(2)
    c.feed(['ab 12'])
    expect(c.feed(['AB  12'])).toEqual(['AB 12'])
  })
})
