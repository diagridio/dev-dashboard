import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { isEditableTarget } from '../../lib/isEditableTarget'
import { useDocumentTitle } from '../../lib/useDocumentTitle'
import { VIEW_H, VIEW_W } from './engine/types'
import { HistoryPanel } from './HistoryPanel'
import { Overlay } from './Overlay'
import { render } from './render/canvas'
import { readPalette, watchTheme, type Palette } from './render/palette'
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
  const [game] = useState(createGame)
  useSyncExternalStore(game.subscribe, game.getVersion)

  useEffect(() => {
    const handler = (down: boolean) => (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const command = keyToCommand(e, down)
      if (!command) return
      e.preventDefault()
      game.command(command)
    }
    const onKeyDown = handler(true)
    const onKeyUp = handler(false)
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
    let frame = 0
    const loop = startLoop((ticks) => {
      game.frame(ticks)
      frame += 1
      if (ctx && palette) render(ctx, { ...game.view(), reducedMotion, frame }, palette)
    })
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') game.suspend()
    }
    const onPageHide = () => game.save()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      loop.stop()
      unwatch()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
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
        <div className="replay-stage">
          <canvas ref={canvasRef} width={VIEW_W} height={VIEW_H} aria-label="REPLAY game screen" />
          <Overlay phase={game.phase} stats={game.stats} best={game.best} score={game.state.score} />
        </div>
        <HistoryPanel history={game.history} />
      </div>
    </div>
  )
}
