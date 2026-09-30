import { GROUND_Y } from '../engine/types'

// One lighting model for every collectible: light from the top-left.
// Only rgba() strings here; theme colours come in through the palette.

/** Light offset as a fraction of an object's radius / half-size. */
export const LIGHT = { x: -0.35, y: -0.35 }

const TWO_PI = Math.PI * 2
const SHADOW_FADE_HEIGHT = 90

/** Darkens the sphere away from the light: a radial overlay clipped to the circle. */
export function shadeSphere(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, strength: number): void {
  const g = ctx.createRadialGradient(cx + LIGHT.x * r, cy + LIGHT.y * r, 0.1 * r, cx, cy, r)
  g.addColorStop(0, 'rgba(255, 255, 255, 0.0)')
  g.addColorStop(0.55, 'rgba(0, 0, 0, 0)')
  g.addColorStop(1, `rgba(0, 0, 0, ${strength})`)
  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, TWO_PI)
  ctx.fillStyle = g
  ctx.fill()
  ctx.restore()
}

/** A soft white highlight with a tiny sharp core. */
export function specular(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  const g = ctx.createRadialGradient(x, y, 0, x, y, size)
  g.addColorStop(0, 'rgba(255, 255, 255, 0.9)')
  g.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.save()
  ctx.beginPath()
  ctx.arc(x, y, size, 0, TWO_PI)
  ctx.fillStyle = g
  ctx.fill()
  ctx.beginPath()
  ctx.arc(x, y, 0.25 * size, 0, TWO_PI)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.95)'
  ctx.fill()
  ctx.restore()
}

/** A flattened ellipse on the ground under an object; smaller and fainter the higher it floats. */
export function groundShadow(ctx: CanvasRenderingContext2D, cx: number, bottomY: number, width: number): void {
  const h = GROUND_Y - bottomY
  const scale = Math.min(1, Math.max(0.35, 1 - h / SHADOW_FADE_HEIGHT))
  const rx = (width / 2) * scale
  const ry = 1.5 * scale
  const y = GROUND_Y + 1
  ctx.save()
  ctx.beginPath()
  if (typeof ctx.ellipse === 'function') {
    ctx.ellipse(cx, y, rx, ry, 0, 0, TWO_PI)
  } else {
    ctx.translate(cx, y)
    ctx.scale(1, ry / rx)
    ctx.arc(0, 0, rx, 0, TWO_PI)
  }
  ctx.fillStyle = `rgba(0, 0, 0, ${0.18 * scale})`
  ctx.fill()
  ctx.restore()
}
