import { LEVELS } from '../engine/levels'
import { PLAYER_H, PLAYER_W, SLIDE_H } from '../engine/step'
import { GROUND_Y, PLAYER_X, TICK_HZ, VIEW_H, VIEW_W, type Entity, type GameState } from '../engine/types'
import type { Phase } from '../runtime/types'
import type { Palette } from './palette'

export interface RenderView {
  state: GameState
  phase: Phase
  notice: string | null
  reducedMotion: boolean
  /** Monotonic frame counter; drives the (deterministic) glitch patterns. */
  frame: number
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

function banner(ctx: CanvasRenderingContext2D, text: string, y: number, color: string, font: string): void {
  ctx.font = font
  ctx.textAlign = 'center'
  ctx.fillStyle = color
  ctx.fillText(text, VIEW_W / 2, y)
}

function drawGround(ctx: CanvasRenderingContext2D, state: GameState, pal: Palette): void {
  ctx.fillStyle = pal.ground
  ctx.fillRect(0, GROUND_Y, VIEW_W, 2)
  const offset = state.scroll % 24
  for (let x = -offset; x < VIEW_W; x += 24) ctx.fillRect(x, GROUND_Y + 10, 10, 2)
}

function drawEntity(ctx: CanvasRenderingContext2D, e: Entity, pal: Palette, replaying: boolean): void {
  if (e.taken) {
    // During a replay, recorded activities are served from history, not re-run.
    if (!replaying || e.kind === 'orb') return
    ctx.font = FONT
    ctx.textAlign = 'center'
    ctx.fillStyle = pal.coin
    ctx.fillText('✓ from history', e.x + e.w / 2, e.y - 4)
    return
  }
  const kind = e.kind
  ctx.fillStyle = kind === 'low' || kind === 'high' ? pal.obstacle : pal[kind]
  if (kind === 'orb') {
    ctx.beginPath()
    ctx.arc(e.x + e.w / 2, e.y + e.h / 2, e.w / 2, 0, Math.PI * 2)
    ctx.fill()
  } else {
    ctx.fillRect(e.x, e.y, e.w, e.h)
  }
  const text = label(e)
  if (text) {
    ctx.font = FONT
    ctx.textAlign = 'center'
    ctx.fillText(text, e.x + e.w / 2, e.y - 4)
  }
}

function drawPlayer(ctx: CanvasRenderingContext2D, state: GameState, pal: Palette): void {
  const p = state.player
  const h = p.sliding && p.y >= GROUND_Y ? SLIDE_H : PLAYER_H
  ctx.fillStyle = pal.player
  ctx.fillRect(PLAYER_X, p.y - h, PLAYER_W, h)
  ctx.fillStyle = pal.bg
  ctx.fillRect(PLAYER_X + 9, p.y - h + 4, 5, 3)
}

function drawHud(ctx: CanvasRenderingContext2D, state: GameState, pal: Palette): void {
  ctx.font = FONT
  ctx.fillStyle = pal.muted
  ctx.textAlign = 'left'
  ctx.fillText(`LEVEL ${state.level} · ${LEVELS[state.level].name.toUpperCase()}`, 10, 18)
  ctx.textAlign = 'right'
  const mult = state.multiplier > 1 ? ` ×${state.multiplier}` : ''
  ctx.fillText(`SCORE ${state.score}${mult} · TICK ${state.tick}`, VIEW_W - 10, 18)
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
  ctx.save()
  ctx.fillStyle = pal.bg
  ctx.fillRect(0, 0, VIEW_W, VIEW_H)
  if (crashing && !view.reducedMotion) ctx.translate(((view.frame * 7) % 9) - 4, ((view.frame * 5) % 7) - 3)
  drawGround(ctx, state, pal)
  for (const e of state.entities) drawEntity(ctx, e, pal, replaying)
  drawPlayer(ctx, state, pal)
  ctx.restore()
  drawHud(ctx, state, pal)
  if (view.notice) banner(ctx, view.notice, 44, pal.text, FONT)
  if (state.bossUntil > 0 && phase.kind === 'playing') drawBoss(ctx, view, pal)
  if (crashing) drawCrash(ctx, view, pal)
  if (replaying) banner(ctx, `⏩ REPLAYING HISTORY · tick ${state.tick}`, 70, pal.glitch, BIG_FONT)
}
