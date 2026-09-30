import { LEVELS } from '../engine/levels'
import { PLAYER_H, PLAYER_W, RACKS, SHIELD_FULL, SLIDE_H } from '../engine/step'
import { GROUND_Y, PLAYER_X, TICK_HZ, VIEW_H, VIEW_W, type Entity, type GameState } from '../engine/types'
import type { Phase } from '../runtime/types'
import { drawBackground } from './background'
import type { Palette } from './palette'
import { NEUTRAL, type Pose } from './pose'
import { drawCoin, drawCrate, drawDebris, drawFallShadow, drawOrb, drawPit, drawRack } from './props'
import { drawHat } from './sprites'

export interface RenderView {
  state: GameState
  phase: Phase
  notice: string | null
  reducedMotion: boolean
  /** Monotonic frame counter; drives the (deterministic) glitch patterns. */
  frame: number
  /** Squash and stretch for the player; neutral when omitted. */
  pose?: Pose
  /** Backing-store pixels per logical pixel (device resolution); 1 when omitted. */
  pixelScale?: number
}

const FONT = '10px ui-monospace, Menlo, Consolas, monospace'
const BIG_FONT = 'bold 14px ui-monospace, Menlo, Consolas, monospace'
/** Orbs are non-deterministic calls made straight from workflow code; crates wrap one in an activity. */
const ORB_LABELS = ['Math.random()', 'Date.now()', 'fetch()'] as const

function label(e: Entity): string | null {
  if (e.kind === 'orb') return ORB_LABELS[e.id % ORB_LABELS.length]
  if (e.kind === 'crate') return 'callActivity(random)'
  return null
}

/** Grace blink: hidden on alternate 4-tick beats. */
const blinkHidden = (s: GameState): boolean => s.tick < s.graceUntil && Math.floor(s.tick / 4) % 2 === 1

function banner(ctx: CanvasRenderingContext2D, text: string, y: number, color: string, font: string): void {
  ctx.font = font
  ctx.textAlign = 'center'
  ctx.fillStyle = color
  ctx.fillText(text, VIEW_W / 2, y)
}

function drawGround(ctx: CanvasRenderingContext2D, state: GameState, pal: Palette): void {
  const pits = state.entities.filter((e) => e.kind === 'pit').sort((a, b) => a.x - b.x)
  for (const p of pits) drawPit(ctx, p, pal)
  ctx.fillStyle = pal.ground
  let x = 0
  for (const p of pits) {
    if (p.x > x) ctx.fillRect(x, GROUND_Y, p.x - x, 2)
    x = Math.max(x, p.x + p.w)
  }
  if (x < VIEW_W) ctx.fillRect(x, GROUND_Y, VIEW_W - x, 2)
  const offset = state.scroll % 24
  for (let dx = -offset; dx < VIEW_W; dx += 24) {
    if (!pits.some((p) => dx + 10 > p.x && dx < p.x + p.w)) ctx.fillRect(dx, GROUND_Y + 10, 10, 2)
  }
}

function drawEntity(ctx: CanvasRenderingContext2D, e: Entity, pal: Palette, replaying: boolean, elapsed: number, reducedMotion: boolean): void {
  if (e.taken) {
    if (RACKS.has(e.kind)) {
      drawDebris(ctx, e, pal)
      return
    }
    // During a replay, recorded activities are served from history, not re-run.
    if (!replaying || e.kind === 'orb') return
    ctx.font = FONT
    ctx.textAlign = 'center'
    ctx.fillStyle = pal.coin
    ctx.fillText('✓ from history', e.x + e.w / 2, e.y - 4)
    return
  }
  const kind = e.kind
  if (kind === 'coin') {
    drawCoin(ctx, e, pal, elapsed, reducedMotion)
    return
  }
  if (kind === 'pit') return
  if (kind === 'low' || kind === 'high' || kind === 'tall' || kind === 'falling') {
    if (kind === 'falling' && e.y + e.h < GROUND_Y) drawFallShadow(ctx, e, pal)
    drawRack(ctx, e, pal, elapsed, reducedMotion)
    return
  }
  if (kind === 'orb') drawOrb(ctx, e, pal)
  else drawCrate(ctx, e, pal)
  ctx.fillStyle = pal[kind]
  const text = label(e)
  if (text) {
    ctx.font = FONT
    ctx.textAlign = 'center'
    ctx.fillText(text, e.x + e.w / 2, e.y - 4)
  }
}

function drawPlayer(ctx: CanvasRenderingContext2D, state: GameState, pal: Palette, pose: Pose, reducedMotion: boolean): void {
  const p = state.player
  const h = p.sliding && p.y >= GROUND_Y ? SLIDE_H : PLAYER_H
  const box = { x: PLAYER_X, y: p.y - h, w: PLAYER_W, h }
  if (state.tick < state.graceUntil && reducedMotion) {
    ctx.strokeStyle = pal.player
    ctx.lineWidth = 1
    ctx.strokeRect(box.x - 2, box.y - 2, box.w + 4, box.h + 4)
  } else if (blinkHidden(state)) {
    return
  }
  drawHat(ctx, box, pal, pose)
}

function drawHud(ctx: CanvasRenderingContext2D, state: GameState, pal: Palette): void {
  ctx.font = FONT
  ctx.fillStyle = pal.muted
  ctx.textAlign = 'left'
  ctx.fillText(`LEVEL ${state.level} · ${LEVELS[state.level].name.toUpperCase()}`, 10, 18)
  ctx.textAlign = 'right'
  const mult = state.multiplier > 1 ? ` ×${state.multiplier}` : ''
  ctx.fillText(`SCORE ${state.score}${mult} · TICK ${state.tick}`, VIEW_W - 10, 18)
  const cfg = LEVELS[state.level]
  ctx.textAlign = 'left'
  if (cfg.retries > 0) {
    ctx.fillStyle = pal.muted
    ctx.fillText('RETRY', 10, 32)
    for (let i = 0; i < cfg.retries; i++) {
      ctx.save()
      if (i >= state.retries) ctx.globalAlpha = 0.25
      drawHat(ctx, { x: 46 + i * 14, y: 25, w: 11, h: 6 }, pal, NEUTRAL)
      ctx.restore()
    }
  }
  if (cfg.shieldEnabled) {
    const armed = state.shield >= SHIELD_FULL
    const x0 = 100
    for (let i = 0; i < SHIELD_FULL; i++) {
      ctx.fillStyle = i < state.shield ? pal.player : pal.ground
      ctx.fillRect(x0 + i * 5, 26, 4, 6)
    }
    ctx.fillStyle = armed ? pal.player : pal.muted
    ctx.fillText(armed ? 'CB ARMED' : `CB ${state.shield}/${SHIELD_FULL}`, x0 + SHIELD_FULL * 5 + 6, 32)
  }
}

function drawCrash(ctx: CanvasRenderingContext2D, view: RenderView, pal: Palette): void {
  if (!view.reducedMotion) {
    ctx.save()
    ctx.globalAlpha = 0.35
    ctx.fillStyle = pal.glitch
    for (let i = 0; i < 12; i++) {
      const y = (view.frame * 37 + i * 53) % VIEW_H
      const w = 40 + ((view.frame * 13 + i * 29) % 200)
      ctx.fillRect((i * 71 + view.frame * 11) % VIEW_W, y, w, 3 + (i % 4))
    }
    ctx.restore()
  }
  banner(ctx, 'daprd: signal: killed', VIEW_H / 2, pal.fail, BIG_FONT)
}

function drawRewind(ctx: CanvasRenderingContext2D, view: RenderView, pal: Palette, attempt: number, of: number): void {
  if (!view.reducedMotion) {
    ctx.save()
    ctx.globalAlpha = 0.25
    ctx.fillStyle = pal.glitch
    for (let i = 0; i < 3; i++) ctx.fillRect(0, (view.frame * 9 + i * 97) % VIEW_H, VIEW_W, 2)
    ctx.restore()
  }
  banner(ctx, `◀◀ RetryPolicy · attempt ${attempt}/${of}`, VIEW_H / 2, pal.glitch, BIG_FONT)
}

function drawBoss(ctx: CanvasRenderingContext2D, view: RenderView, pal: Palette): void {
  const left = Math.max(0, Math.ceil((view.state.bossUntil - view.state.tick) / TICK_HZ))
  ctx.save()
  ctx.globalAlpha = 0.08
  ctx.fillStyle = pal.fail
  ctx.fillRect(0, 0, VIEW_W, VIEW_H)
  if (!view.reducedMotion) {
    ctx.globalAlpha = 0.18
    for (let y = (view.frame * 3) % 6; y < VIEW_H; y += 6) ctx.fillRect(0, y, VIEW_W, 1)
  }
  ctx.restore()
  banner(ctx, `NonDeterministicError · survive ${left}s`, 64, pal.fail, BIG_FONT)
}

export function render(ctx: CanvasRenderingContext2D, view: RenderView, pal: Palette): void {
  const { state, phase } = view
  const crashing = phase.kind === 'crashing'
  const replaying = phase.kind === 'replaying'
  // Base transform first: everything below draws in the 480x270 logical space at any backing-store size.
  const scale = view.pixelScale ?? 1
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  ctx.save()
  ctx.fillStyle = pal.bg
  ctx.fillRect(0, 0, VIEW_W, VIEW_H)
  if (crashing && !view.reducedMotion) ctx.translate(((view.frame * 7) % 9) - 4, ((view.frame * 5) % 7) - 3)
  drawBackground(ctx, state.distance + state.scroll, pal, state.elapsed, view.reducedMotion)
  drawGround(ctx, state, pal)
  for (const e of state.entities) drawEntity(ctx, e, pal, replaying, state.elapsed, view.reducedMotion)
  drawPlayer(ctx, state, pal, view.pose ?? NEUTRAL, view.reducedMotion)
  ctx.restore()
  drawHud(ctx, state, pal)
  if (view.notice) banner(ctx, view.notice, 44, pal.text, FONT)
  if (state.bossUntil > 0 && phase.kind === 'playing') drawBoss(ctx, view, pal)
  if (crashing) drawCrash(ctx, view, pal)
  if (phase.kind === 'rewinding') drawRewind(ctx, view, pal, phase.attempt, phase.of)
  if (replaying) banner(ctx, `⏩ REPLAYING HISTORY · tick ${state.tick}`, 70, pal.glitch, BIG_FONT)
}
