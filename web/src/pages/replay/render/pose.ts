import { GROUND_Y, type Player } from '../engine/types'

/** Render-only scale of the player sprite. Never feeds back into collision. */
export interface Pose { sx: number; sy: number }

export const NEUTRAL: Pose = { sx: 1, sy: 1 }
/** Rendered frames the landing fold lasts. */
export const LAND_FRAMES = 8

const RISE_STRETCH = 0.35
const FALL_STRETCH = 0.2
const LAND_FOLD = 0.35

/** Squash and stretch for the hat; stateful, call once per rendered frame. */
export class HatPose {
  private wasAirborne = false
  /** Frames of landing fold already shown; LAND_FRAMES when idle. */
  private landed = LAND_FRAMES

  update(player: Player, reducedMotion: boolean): Pose {
    const airborne = player.y < GROUND_Y
    if (reducedMotion) {
      this.wasAirborne = airborne
      this.landed = LAND_FRAMES
      return NEUTRAL
    }
    if (airborne) {
      this.wasAirborne = true
      this.landed = LAND_FRAMES
      const sy = player.vy < 0
        ? 1 + Math.min(RISE_STRETCH, -player.vy * 0.04)
        : 1 + Math.min(FALL_STRETCH, player.vy * 0.025)
      return { sx: 1 / sy, sy }
    }
    if (this.wasAirborne) {
      this.wasAirborne = false
      this.landed = 0
    }
    if (this.landed < LAND_FRAMES) {
      const t = 1 - this.landed / LAND_FRAMES
      this.landed += 1
      return { sx: 1 + LAND_FOLD * t, sy: 1 - LAND_FOLD * t }
    }
    return NEUTRAL
  }
}
