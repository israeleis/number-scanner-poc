import { describe, expect, it } from 'vitest'
import { alignTo, levenshtein, vote } from './vote'

let frame = 0
const read = (text: string, confidence = 0.9, weight = 1) => ({ text, confidence, weight, frame: frame++ })

describe('vote', () => {
  it('takes the majority character at each position', () => {
    const out = vote([read('A123456'), read('A128456'), read('A123456'), read('A123458')])
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe('A123456')
    expect(out[0].frames).toBe(4)
  })

  it('handles a read that dropped a character', () => {
    const out = vote([read('7731052'), read('773152'), read('7731052')])
    expect(out[0].text).toBe('7731052')
  })

  it('keeps different numbers in the same frame apart', () => {
    const out = vote([read('A123456'), read('STOP 42'), read('A123456'), read('STOP 42')])
    expect(out.map((v) => v.text).sort()).toEqual(['A123456', 'STOP 42'])
  })

  it('lets sharper frames outvote blurred ones', () => {
    const out = vote([read('1234', 0.9, 0.2), read('1284', 0.9, 0.9)])
    expect(out[0].text).toBe('1284')
  })

  it('counts frames, not reads, when a text appears twice in one frame', () => {
    expect(vote([{ ...read('42'), frame: 1 }, { ...read('42'), frame: 1 }])[0].frames).toBe(1)
  })

  it('reports full agreement when every frame agrees', () => {
    expect(vote([read('42'), read('42')])[0].agreement).toBe(1)
  })
})

describe('alignment helpers', () => {
  it('measures edit distance', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3)
  })
  it('aligns a shorter read to the reference', () => {
    expect(alignTo('A123', 'A23')).toEqual(['A', '', '2', '3'])
  })
})
