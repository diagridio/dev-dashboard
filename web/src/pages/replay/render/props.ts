import type { Entity } from '../engine/types'
import type { Palette } from './palette'

// Cheap canvas props for the run: shiny round coins and mini server racks.
// Animation is driven by game time (`elapsed`, fixed 60 Hz), never the frame counter.

const GLINT_PERIOD = 120
const GLINT_TICKS = 12
const LED_PERIOD = 30
const TWO_PI = Math.PI * 2

const SHADE = 'rgba(0, 0, 0, 0.25)'
const BEZEL = 'rgba(0, 0, 0, 0.35)'
const LIGHT = 'rgba(255, 255, 255, 0.25)'
const LED_DIM = 'rgba(255, 255, 255, 0.12)'

function circle(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, TWO_PI)
}

/** A gold coin filling its box: dark rim, bright inner ring, highlight and an occasional glint. */
export function drawCoin(ctx: CanvasRenderingContext2D, e: Entity, pal: Palette, elapsed: number, reducedMotion: boolean): void {
  const r = e.w / 2
  const cx = e.x + r
  const cy = e.y + e.h / 2
  circle(ctx, cx, cy, r)
  ctx.fillStyle = pal.coin
  ctx.fill()
  ctx.lineWidth = 1.2
  circle(ctx, cx, cy, r - 0.6)
  ctx.strokeStyle = pal.coin
  ctx.stroke()
  ctx.strokeStyle = SHADE
  ctx.stroke()
  ctx.lineWidth = 0.8
  circle(ctx, cx, cy, r * 0.62)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)'
  ctx.stroke()
  circle(ctx, cx - r * 0.35, cy - r * 0.35, r * 0.2)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.8)'
  ctx.fill()
  if (reducedMotion) return
  const phase = (elapsed + e.id * 37) % GLINT_PERIOD
  if (phase >= GLINT_TICKS) return
  const x = cx + (-1.2 + 2.4 * (phase / GLINT_TICKS)) * r
  ctx.save()
  circle(ctx, cx, cy, r)
  ctx.clip()
  ctx.beginPath()
  ctx.moveTo(x - 1, cy + r)
  ctx.lineTo(x + 1, cy + r)
  ctx.lineTo(x + 1 + r, cy - r)
  ctx.lineTo(x - 1 + r, cy - r)
  ctx.closePath()
  ctx.fillStyle = 'rgba(255, 255, 255, 0.45)'
  ctx.fill()
  ctx.restore()
}

/** A mini server rack in the obstacle's exact hitbox; high ones hang from a cable to the top edge. */
export function drawRack(ctx: CanvasRenderingContext2D, e: Entity, pal: Palette, elapsed: number, reducedMotion: boolean): void {
  if (e.kind === 'high') {
    const cx = e.x + e.w / 2
    ctx.beginPath()
    ctx.moveTo(cx, 0)
    ctx.lineTo(cx, e.y)
    ctx.lineWidth = 1
    ctx.strokeStyle = pal.ground
    ctx.stroke()
    ctx.fillStyle = pal.ground
    ctx.fillRect(cx - 2, e.y - 2, 4, 2)
  }
  ctx.fillStyle = pal.obstacle
  ctx.fillRect(e.x, e.y, e.w, e.h)
  const x0 = e.x + 2
  const y0 = e.y + 2
  const iw = e.w - 4
  const ih = e.h - 4
  ctx.fillStyle = BEZEL
  ctx.fillRect(x0, y0, iw, ih)
  // Unit slots every 5 px, and a vent grille on the second unit.
  ctx.fillStyle = LIGHT
  for (let y = y0 + 5; y + 1 <= y0 + ih; y += 5) ctx.fillRect(x0, y, iw, 1)
  for (let x = x0 + 1; x + 1 <= x0 + iw - 1; x += 2) ctx.fillRect(x, y0 + 7, 1, 1)
  // Two status LEDs on the top unit, blinking out of phase.
  for (let i = 0; i < 2; i++) {
    const on = reducedMotion || Math.floor((elapsed + e.id * 11 + i * 17) / LED_PERIOD) % 2 === 0
    ctx.fillStyle = on ? pal.player : LED_DIM
    ctx.fillRect(i === 0 ? x0 + 1 : x0 + iw - 3, y0 + 1.5, 2, 2)
  }
}
