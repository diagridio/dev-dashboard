import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { isInteractiveTarget } from '../../lib/isEditableTarget'
import { useDocumentTitle } from '../../lib/useDocumentTitle'
import { VIEW_H, VIEW_W } from './engine/types'
import { HistoryPanel } from './HistoryPanel'
import { Overlay } from './Overlay'
import { render } from './render/canvas'
import { blend } from './render/interpolate'
import { readPalette, watchTheme, type Palette } from './render/palette'
import { HatPose } from './render/pose'
import { Game } from './runtime/game'
import { keyToCommand } from './runtime/keys'
import { startLoop } from './runtime/loop'
import { localSaveStore } from './runtime/persistence'

function createGame(): Game {
  return new Game({
    impure: Math.random, // the one deliberate source of non-determinism
    chaosRand: Math.random, // chaos is the outside world
    newSeed: () => Math.floor(Math.random() * 0x100000000),
    store: localSaveStore(),
  })
}

/** REPLAY easter egg. Lazy route module: react-router's `lazy` expects `Component`. */
export function Component() {
  useDocumentTitle('Replay')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [game] = useState(createGame)
  useSyncExternalStore(game.subscribe, game.getVersion)

  useEffect(() => {
    // Arriving from a sidebar link leaves focus there; move it to the game so Enter starts it.
    stageRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Keys aimed at the app shell (links, buttons, fields, dialogs) are not game keys.
      if (e.ctrlKey || e.metaKey || e.altKey || isInteractiveTarget(e.target)) return
      const command = keyToCommand(e, true)
      if (!command) return
      e.preventDefault()
      game.command(command)
    }
    // Releases always get through (they only ever end a slide), so a slide never sticks.
    const onKeyUp = (e: KeyboardEvent) => {
      const command = keyToCommand(e, false)
      if (command) game.command(command)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [game])

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d') ?? null
    let palette: Palette | null = canvas ? readPalette(canvas) : null
    const unwatch = watchTheme(() => {
      if (canvas) palette = readPalette(canvas)
    })
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const hatPose = new HatPose()
    // Back the canvas with device pixels; drawing stays in the 480x270 logical space via pixelScale.
    let pixelScale = 1
    const fit = () => {
      if (!canvas || typeof ResizeObserver === 'undefined' || canvas.clientWidth === 0) return
      const width = Math.round(canvas.clientWidth * (window.devicePixelRatio || 1))
      const height = Math.round((width * VIEW_H) / VIEW_W)
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }
      pixelScale = canvas.width / VIEW_W
    }
    const resizeObserver = canvas && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null
    if (canvas) resizeObserver?.observe(canvas)
    // Moving the window between monitors changes the pixel ratio without resizing the canvas.
    window.addEventListener('resize', fit)
    fit()
    let frame = 0
    const loop = startLoop((ticks, alpha) => {
      game.frame(ticks)
      frame += 1
      const pose = hatPose.update(game.state.player, reducedMotion)
      const view = game.view()
      if (ctx && palette) {
        render(ctx, { ...view, state: blend(view.prev, view.state, alpha), reducedMotion, frame, pose, pixelScale }, palette)
      }
    })
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') game.suspend()
    }
    const onPageHide = () => game.save()
    const onBlur = () => game.suspend()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('blur', onBlur)
    return () => {
      loop.stop()
      resizeObserver?.disconnect()
      window.removeEventListener('resize', fit)
      unwatch()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('blur', onBlur)
      game.suspend()
    }
  }, [game])

  return (
    <div className="page">
      <div className="phead">
        <div>
          <h1>REPLAY</h1>
          <div className="sub">A durable execution game. Crash as often as you like.</div>
        </div>
      </div>
      <div className="replay-grid">
        <div className="replay-stage" ref={stageRef} tabIndex={0} aria-label="REPLAY game">
          <canvas ref={canvasRef} width={VIEW_W} height={VIEW_H} aria-label="REPLAY game screen" />
          <Overlay phase={game.phase} stats={game.stats} best={game.best} score={game.state.score} level={game.state.level} />
        </div>
        <HistoryPanel history={game.history} />
      </div>
    </div>
  )
}
