import { describe, expect, it } from 'vitest'
import { GROUND_Y, type Player } from '../engine/types'
import { HatPose, LAND_FRAMES, NEUTRAL } from './pose'

const ground: Player = { y: GROUND_Y, vy: 0, sliding: false, jumpHeld: false, coyoteUntil: 0, jumpBufferUntil: 0 }
const rising: Player = { y: GROUND_Y - 30, vy: -6, sliding: false, jumpHeld: false, coyoteUntil: 0, jumpBufferUntil: 0 }
const falling: Player = { y: GROUND_Y - 30, vy: 5, sliding: false, jumpHeld: false, coyoteUntil: 0, jumpBufferUntil: 0 }

describe('HatPose', () => {
  it('is neutral on the ground', () => {
    expect(new HatPose().update(ground, false)).toEqual(NEUTRAL)
  })

  it('stretches while rising, keeping the area roughly constant', () => {
    const pose = new HatPose().update(rising, false)
    expect(pose.sy).toBeGreaterThan(1)
    expect(pose.sx).toBeLessThan(1)
    expect(pose.sx * pose.sy).toBeCloseTo(1)
  })

  it('caps the stretch and stretches less while falling', () => {
    expect(new HatPose().update({ y: 10, vy: -50, sliding: false, jumpHeld: false, coyoteUntil: 0, jumpBufferUntil: 0 }, false).sy).toBeCloseTo(1.35)
    expect(new HatPose().update({ y: 10, vy: 50, sliding: false, jumpHeld: false, coyoteUntil: 0, jumpBufferUntil: 0 }, false).sy).toBeCloseTo(1.2)
    const fall = new HatPose().update(falling, false)
    expect(fall.sy).toBeGreaterThan(1)
    expect(fall.sy).toBeLessThan(new HatPose().update(rising, false).sy)
  })

  it('folds on the frame after landing and returns to neutral after LAND_FRAMES', () => {
    const hat = new HatPose()
    hat.update(falling, false)
    const first = hat.update(ground, false)
    expect(first.sy).toBeLessThan(1)
    expect(first.sx).toBeGreaterThan(1)
    for (let k = 1; k < LAND_FRAMES; k++) expect(hat.update(ground, false).sy).toBeLessThan(1)
    expect(hat.update(ground, false)).toEqual(NEUTRAL)
  })

  it('is always neutral with reduced motion', () => {
    const hat = new HatPose()
    expect(hat.update(rising, true)).toEqual(NEUTRAL)
    expect(hat.update(falling, true)).toEqual(NEUTRAL)
    expect(hat.update(ground, true)).toEqual(NEUTRAL)
  })
})
