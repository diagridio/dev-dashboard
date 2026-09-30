import { GROUND_Y, VIEW_H, type Entity } from '../engine/types'
import type { Palette } from './palette'
import { groundShadow, LIGHT as LIGHT_DIR, shadeSphere, specular } from './shading'

// Cheap canvas props for the run: glossy orbs, shiny round coins, shaded crates and mini server racks.
// Animation is driven by game time (`elapsed`, fixed 60 Hz), never the frame counter.

const GLINT_PERIOD = 120
const GLINT_TICKS = 12
const LED_PERIOD = 30
const TWO_PI = Math.PI * 2

const SHADE = 'rgba(0, 0, 0, 0.25)'
/** Darkens the obstacle red for pit shafts. */
export const PIT_DARKEN = 'rgba(0, 0, 0, 0.45)'
const BEZEL = 'rgba(0, 0, 0, 0.35)'
const LIGHT = 'rgba(255, 255, 255, 0.25)'
const LED_DIM = 'rgba(255, 255, 255, 0.12)'

function circle(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, TWO_PI)
}

/** A glossy purple sphere (a non-deterministic call): shadow, shaded body, rim light and a specular spot. */
export function drawOrb(ctx: CanvasRenderingContext2D, e: Entity, pal: Palette): void {
  if (e.taken) return
  const r = e.w / 2
  const cx = e.x + r
  const cy = e.y + e.h / 2
  groundShadow(ctx, cx, e.y + e.h, e.w)
  circle(ctx, cx, cy, r)
  ctx.fillStyle = pal.orb
  ctx.fill()
  shadeSphere(ctx, cx, cy, r, 0.45)
  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, r - 0.8, 0, Math.PI / 2)
  ctx.lineWidth = 1
  ctx.strokeStyle = LIGHT
  ctx.stroke()
  ctx.restore()
  specular(ctx, cx + LIGHT_DIR.x * r, cy + LIGHT_DIR.y * r, 0.45 * r)
}

/** A shaded crate (an activity call) in its exact hitbox: shadow, gradient, bevel and a corner highlight. */
export function drawCrate(ctx: CanvasRenderingContext2D, e: Entity, pal: Palette): void {
  if (e.taken) return
  groundShadow(ctx, e.x + e.w / 2, e.y + e.h, e.w)
  ctx.fillStyle = pal.crate
  ctx.fillRect(e.x, e.y, e.w, e.h)
  const g = ctx.createLinearGradient(e.x, e.y, e.x + e.w, e.y + e.h)
  g.addColorStop(0, 'rgba(255, 255, 255, 0.18)')
  g.addColorStop(1, 'rgba(0, 0, 0, 0.28)')
  ctx.fillStyle = g
  ctx.fillRect(e.x, e.y, e.w, e.h)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.45)'
  ctx.fillRect(e.x, e.y, e.w, 1)
  ctx.fillRect(e.x, e.y, 1, e.h)
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)'
  ctx.fillRect(e.x, e.y + e.h - 1, e.w, 1)
  ctx.fillRect(e.x + e.w - 1, e.y, 1, e.h)
  const m = Math.min(e.w, e.h)
  specular(ctx, e.x + 0.3 * m, e.y + 0.3 * m, 0.3 * m)
}

/** A gold coin filling its box: shadow, shaded disc, dark rim, bright inner ring, specular and an occasional glint. */
export function drawCoin(ctx: CanvasRenderingContext2D, e: Entity, pal: Palette, elapsed: number, reducedMotion: boolean): void {
  const r = e.w / 2
  const cx = e.x + r
  const cy = e.y + e.h / 2
  groundShadow(ctx, cx, e.y + e.h, e.w)
  circle(ctx, cx, cy, r)
  ctx.fillStyle = pal.coin
  ctx.fill()
  shadeSphere(ctx, cx, cy, r, 0.25)
  ctx.save()
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
  ctx.restore()
  specular(ctx, cx + LIGHT_DIR.x * r, cy + LIGHT_DIR.y * r, 0.4 * r)
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
  if (e.kind === 'high' || (e.kind === 'falling' && e.y + e.h < GROUND_Y)) {
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

/** The fan-out gate: an arch the hat runs through, labelled with the fan-out. */
export function drawGate(ctx: CanvasRenderingContext2D, e: Entity, pal: Palette): void {
  const top = GROUND_Y - 64
  ctx.fillStyle = pal.glitch
  ctx.fillRect(e.x, top, 3, GROUND_Y - top)
  ctx.fillRect(e.x + e.w - 3, top, 3, GROUND_Y - top)
  ctx.fillRect(e.x - 4, top - 4, e.w + 8, 4)
  ctx.font = '10px ui-monospace, Menlo, Consolas, monospace'
  ctx.textAlign = 'center'
  ctx.fillText('fan-out ×3', e.x + e.w / 2, top - 8)
}

/** A pit: a dark red shaft under a gap in the ground line. */
export function drawPit(ctx: CanvasRenderingContext2D, e: Entity, pal: Palette): void {
  // Obstacle red, darkened, so a pit reads as a hazard in both themes and at half scale in the fan-out lanes.
  ctx.fillStyle = pal.obstacle
  ctx.fillRect(e.x, GROUND_Y, e.w, VIEW_H - GROUND_Y)
  ctx.fillStyle = PIT_DARKEN
  ctx.fillRect(e.x, GROUND_Y, e.w, VIEW_H - GROUND_Y)
  ctx.fillStyle = SHADE
  ctx.fillRect(e.x, GROUND_Y, 2, VIEW_H - GROUND_Y)
  ctx.fillRect(e.x + e.w - 2, GROUND_Y, 2, VIEW_H - GROUND_Y)
}

/** Where a falling rack will land: a shadow that darkens as the rack drops. */
export function drawFallShadow(ctx: CanvasRenderingContext2D, e: Entity, pal: Palette): void {
  const drop = Math.max(0, Math.min(1, (e.y + e.h) / GROUND_Y))
  ctx.save()
  ctx.globalAlpha = 0.2 + 0.5 * drop
  ctx.fillStyle = pal.obstacle
  ctx.beginPath()
  ctx.ellipse(e.x + e.w / 2, GROUND_Y + 1, (e.w / 2) * (0.5 + 0.5 * drop), 2, 0, 0, TWO_PI)
  ctx.fill()
  ctx.restore()
}

/** A rack the circuit breaker barged through: a few broken units on the floor. */
export function drawDebris(ctx: CanvasRenderingContext2D, e: Entity, pal: Palette): void {
  ctx.fillStyle = pal.obstacle
  const n = 4
  for (let i = 0; i < n; i++) {
    const w = 3 + ((e.id + i * 7) % 4)
    ctx.fillRect(e.x - 4 + i * (e.w / n + 3), GROUND_Y - 3 - ((e.id + i) % 3), w, 3)
  }
}
