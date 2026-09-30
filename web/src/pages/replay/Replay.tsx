import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ShareDialog } from '../../components/ShareDialog'
import { copyText } from '../../lib/clipboard'
import { isInteractiveTarget } from '../../lib/isEditableTarget'
import { trackAction } from '../../lib/telemetry'
import { useDocumentTitle } from '../../lib/useDocumentTitle'
import { livePlayer } from './engine/step'
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
import { utcDate } from './runtime/daily'
import { localSaveStore } from './runtime/persistence'
import { decodeRun, shareableRunCode } from './runtime/share'

function createGame(): Game {
  return new Game({
    impure: Math.random, // the one deliberate source of non-determinism
    chaosRand: Math.random, // chaos is the outside world
    today: () => utcDate(),
    store: localSaveStore(),
  })
}

/** REPLAY easter egg. Lazy route module: react-router's `lazy` expects `Component`. */
export function Component() {
  useDocumentTitle('Replay')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [game] = useState(createGame)
  const [shareOpen, setShareOpen] = useState(false)
  const [executionId, setExecutionId] = useState<string | null>(null)
  const [executionIdError, setExecutionIdError] = useState<string | null>(null)
  const [idCopied, setIdCopied] = useState(false)
  // Bumped whenever the game-over card goes away, so a slow encode can't land on the next one.
  const cardToken = useRef(0)
  const [watchError, setWatchError] = useState<string | null>(null)
  useSyncExternalStore(game.subscribe, game.getVersion)

  // Every game-over card shows the finished run's execution ID (its run code).
  useEffect(() => {
    if (game.phase.kind !== 'over') {
      cardToken.current += 1
      setExecutionId(null)
      setExecutionIdError(null)
      setIdCopied(false)
      return
    }
    const token = cardToken.current
    shareableRunCode(game.tape).then(
      (id) => {
        if (token !== cardToken.current) return
        if (id === null) setExecutionIdError('This run is too long to share.')
        else setExecutionId(id)
      },
      () => {
        if (token === cardToken.current) setExecutionIdError("Couldn't create an execution ID.")
      },
    )
  }, [game, game.phase.kind])

  const onCopyExecutionId = () => {
    if (!executionId) return
    trackAction('replay_share_copy')
    copyText(executionId)
    setIdCopied(true)
    // Back to the stage, so Enter means "play again" rather than re-clicking the button.
    stageRef.current?.focus()
  }

  /** Plays back the run behind an execution ID; false when the ID isn't a valid one. */
  const replayFrom = async (id: string): Promise<boolean> => {
    const tape = await decodeRun(id)
    if (!tape || !game.watch(tape)) return false
    stageRef.current?.focus()
    return true
  }

  const onReplayRun = async () => {
    trackAction('replay_rerun')
    // Replays from the execution ID itself; a run too long to have one replays from its tape.
    if (executionId) await replayFrom(executionId)
    else if (game.watch(structuredClone(game.tape))) stageRef.current?.focus()
  }

  const onWatch = async (code: string) => {
    trackAction('replay_watch')
    if (!(await replayFrom(code))) {
      setWatchError("That execution ID isn't valid.")
      return
    }
    setWatchError(null)
  }

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
      const pose = hatPose.update(livePlayer(game.state), reducedMotion)
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
          <Overlay
            phase={game.phase}
            stats={game.stats}
            best={game.best}
            score={game.state.score}
            level={game.state.level}
            date={game.runDate}
            dailyBest={game.dailyBest}
            playback={game.playback}
            executionId={executionId}
            executionIdError={executionIdError}
            idCopied={idCopied}
            watchError={watchError}
            onCopyExecutionId={onCopyExecutionId}
            onReplayRun={() => void onReplayRun()}
            onWatch={(c) => void onWatch(c)}
            onShare={() => {
              setShareOpen(true)
              trackAction('share_open', { source: 'replay' })
            }}
          />
        </div>
        {/* Level 0 has no durable history, so the panel only appears from level 1. Its
            grid column stays reserved so the canvas doesn't resize when it does. */}
        {game.state.level >= 1 && <HistoryPanel history={game.history} />}
      </div>
      <ShareDialog open={shareOpen} onClose={() => setShareOpen(false)} />
    </div>
  )
}
