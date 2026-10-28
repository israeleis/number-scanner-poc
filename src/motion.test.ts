import { describe, expect, it } from 'vitest'
import { FrameDiff, SteadyGate } from './motion'

const settings = { waitSteady: true, gyroThreshold: 25, diffThreshold: 12, steadyMs: 150 }

describe('SteadyGate', () => {
  it('waits until the phone has been still for a while', () => {
    const g = new SteadyGate(settings)
    expect(g.judge(30, undefined, 0).steady).toBe(false)
    expect(g.judge(2, undefined, 100).steady).toBe(false)
    expect(g.judge(2, undefined, 160).steady).toBe(true)
  })

  it('a fast turn read by the gyroscope counts as moving even if the picture barely changed', () => {
    const g = new SteadyGate(settings)
    expect(g.judge(1, 80, 0).moving).toBe(true)
    expect(g.judge(1, 5, 200).steady).toBe(true)
  })

  it('with waiting off, every frame may be read', () => {
    expect(new SteadyGate({ ...settings, waitSteady: false }).judge(50, 200, 0).steady).toBe(true)
  })
})

describe('FrameDiff', () => {
  it('is the mean change between two pictures', () => {
    const d = new FrameDiff()
    expect(d.next(new Uint8Array([10, 10, 10, 10]))).toBe(0)
    expect(d.next(new Uint8Array([20, 10, 30, 10]))).toBe(7.5)
  })
})
