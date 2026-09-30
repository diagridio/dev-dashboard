import { GROUND_Y, VIEW_W } from '../engine/types'
import type { Palette } from './palette'

// A quiet datacenter behind the run: server racks far back, desks with computers
// nearer. Both scroll slower than the ground (parallax), use theme tokens at low
// alpha and draw only what is on screen. Variants come from an integer hash of
// the tile index, never Math.random, so the scenery is stable as it scrolls.

const FAR_PARALLAX = 0.2
const FAR_TILE = 64
const NEAR_PARALLAX = 0.5
const NEAR_TILE = 120
/** LEDs change state every this many game ticks (30 = 0.5 s at the fixed 60 Hz). */
const BLINK_TICKS = 30

/** Small deterministic integer hash of (a, b) → unsigned 32 bit. */
function hash(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return (h ^ (h >>> 15)) >>> 0
}

/** Whether an LED with this hash is lit at this game time; static under reduced motion. */
function lit(h: number, ticks: number, reducedMotion: boolean): boolean {
  return (h + (reducedMotion ? 0 : Math.floor(ticks / BLINK_TICKS))) % 4 === 0
}

function led(ctx: CanvasRenderingContext2D, pal: Palette, x: number, y: number): void {
  ctx.globalAlpha = 0.45
  ctx.fillStyle = pal.player
  ctx.fillRect(x, y, 2, 2)
}

/** Fills and outlines a box in the backdrop and line tokens. */
function panel(ctx: CanvasRenderingContext2D, pal: Palette, x: number, y: number, w: number, h: number, fill: number, line: number): void {
  ctx.globalAlpha = fill
  ctx.fillStyle = pal.backdrop
  ctx.fillRect(x, y, w, h)
  ctx.globalAlpha = line
  ctx.strokeStyle = pal.ground
  ctx.lineWidth = 1
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
}

/** Far layer: server racks, one per 64 px tile. */
export function drawRacks(ctx: CanvasRenderingContext2D, worldX: number, pal: Palette, ticks: number, reducedMotion: boolean): void {
  const offset = worldX * FAR_PARALLAX
  for (let i = Math.floor(offset / FAR_TILE); i * FAR_TILE - offset < VIEW_W; i++) {
    const tileX = i * FAR_TILE - offset
    if (tileX + FAR_TILE <= 0) continue
    const h = hash(i, 0)
    const w = 30 + (h % 9)
    const height = 70 + ((h >>> 8) % 41)
    const x = tileX + (FAR_TILE - w) / 2
    const top = GROUND_Y - height
    panel(ctx, pal, x, top, w, height, 0.6, 0.5)
    // A line every 8 px marks the rack units; some units carry a blinking LED.
    for (let row = 1; row * 8 < height; row++) {
      ctx.globalAlpha = 0.5
      ctx.fillStyle = pal.ground
      ctx.fillRect(x, top + row * 8, w, 1)
      const hl = hash(i, row)
      if ((hl >>> 4) % 2 === 0 && lit(hl, ticks, reducedMotion)) led(ctx, pal, x + w - 6, top + row * 8 - 5)
    }
  }
}

/** Near layer: desks with a monitor and sometimes a tower PC, on about 60% of 120 px tiles. */
export function drawDesks(ctx: CanvasRenderingContext2D, worldX: number, pal: Palette, ticks: number, reducedMotion: boolean): void {
  const offset = worldX * NEAR_PARALLAX
  for (let i = Math.floor(offset / NEAR_TILE); i * NEAR_TILE - offset < VIEW_W; i++) {
    const tileX = i * NEAR_TILE - offset
    if (tileX + NEAR_TILE <= 0) continue
    const h = hash(i, 1)
    if (h % 5 >= 3) continue
    const x = tileX + 24 + ((h >>> 8) % 20)
    const deskY = GROUND_Y - 26
    // Desk top and two legs.
    ctx.globalAlpha = 0.7
    ctx.fillStyle = pal.ground
    ctx.fillRect(x, deskY, 50, 3)
    ctx.fillRect(x + 3, deskY + 3, 2, 23)
    ctx.fillRect(x + 45, deskY + 3, 2, 23)
    // Monitor on a stand.
    ctx.fillRect(x + 15, deskY - 4, 4, 4)
    ctx.fillRect(x + 11, deskY - 1, 12, 1)
    panel(ctx, pal, x + 6, deskY - 18, 22, 14, 0.9, 0.6)
    if (lit(hash(i, 2), ticks, reducedMotion)) led(ctx, pal, x + 24, deskY - 7)
    // Tower PC beside it.
    if ((h >>> 16) % 2 === 0) {
      panel(ctx, pal, x + 34, deskY - 20, 9, 20, 0.9, 0.6)
      if (lit(hash(i, 3), ticks, reducedMotion)) led(ctx, pal, x + 37, deskY - 16)
    }
  }
}

/** Draws both layers; `worldX` is distance + scroll so the scenery keeps moving across segments; `ticks` is game time, so LEDs blink at the same rate on any display. */
export function drawBackground(ctx: CanvasRenderingContext2D, worldX: number, pal: Palette, ticks: number, reducedMotion: boolean): void {
  ctx.save()
  drawRacks(ctx, worldX, pal, ticks, reducedMotion)
  drawDesks(ctx, worldX, pal, ticks, reducedMotion)
  ctx.restore()
}
