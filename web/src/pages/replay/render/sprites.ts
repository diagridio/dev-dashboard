import type { Palette } from './palette'
import { NEUTRAL, type Pose } from './pose'

export interface Box { x: number; y: number; w: number; h: number }

// Dapr hat artwork (CNCF artwork, dapr-icon-color.svg, viewBox 0 0 480 255.6).
// Coordinates are in art units; ART is the bounding box that gets mapped onto
// the target box, so the same art can be squashed flat for the slide.
const ART: Box = { x: 10.67987, y: 11.18938, w: 456.64027, h: 233.42107 }
const CROWN = { x: 99.78042, y: 11.18938, w: 282.15168, h: 198.57274, r: 5.49347 }
const BRIM = { x: 10.67987, y: 196.95093, w: 456.64027, h: 47.65952, r: 10.21827 }
// Left-hand sheen, clipped to each part's rounded shape (brim height clamped to the brim box).
const CROWN_SHEEN: Box = { x: 99.78042, y: 11.18938, w: 104.36936, h: 198.57274 }
const BRIM_SHEEN: Box = { x: 10.67987, y: 196.95093, w: 141.28521, h: 47.65952 }
const SHEEN = 'rgba(255, 255, 255, 0.08)'

/** Maps art-space rects onto the target box. */
function mapper(box: Box) {
  const kx = box.w / ART.w
  const ky = box.h / ART.h
  return {
    rect: (r: Box): Box => ({ x: box.x + (r.x - ART.x) * kx, y: box.y + (r.y - ART.y) * ky, w: r.w * kx, h: r.h * ky }),
    radius: (r: number) => r * Math.min(kx, ky),
  }
}

function shape(ctx: CanvasRenderingContext2D, r: Box, radius: number): void {
  ctx.beginPath()
  // roundRect is missing in older browsers and jsdom; plain corners are fine at this size.
  if (typeof ctx.roundRect === 'function') ctx.roundRect(r.x, r.y, r.w, r.h, radius)
  else ctx.rect(r.x, r.y, r.w, r.h)
}

/**
 * Draws the Dapr hat into `box`. The art's bounding box is stretched to fit,
 * so a shorter box gives a flattened hat rather than a cropped one. A pose
 * scales the box around its bottom centre, so the hat's base stays put.
 */
export function drawHat(ctx: CanvasRenderingContext2D, box: Box, pal: Palette, pose: Pose = NEUTRAL): void {
  const w = box.w * pose.sx
  const h = box.h * pose.sy
  const m = mapper({ x: box.x + (box.w - w) / 2, y: box.y + box.h - h, w, h })
  const parts = [
    { rect: m.rect(CROWN), radius: m.radius(CROWN.r), sheen: m.rect(CROWN_SHEEN) },
    { rect: m.rect(BRIM), radius: m.radius(BRIM.r), sheen: m.rect(BRIM_SHEEN) },
  ]
  ctx.fillStyle = pal.hat
  for (const p of parts) {
    shape(ctx, p.rect, p.radius)
    ctx.fill()
  }
  for (const p of parts) {
    ctx.save()
    shape(ctx, p.rect, p.radius)
    ctx.clip()
    ctx.fillStyle = SHEEN
    ctx.beginPath()
    ctx.rect(p.sheen.x, p.sheen.y, p.sheen.w, p.sheen.h)
    ctx.fill()
    ctx.restore()
  }
  if (pal.hatOutline !== 'transparent') {
    ctx.strokeStyle = pal.hatOutline
    ctx.lineWidth = 1
    for (const p of parts) {
      shape(ctx, p.rect, p.radius)
      ctx.stroke()
    }
  }
}
