import { useEffect, useRef, useState } from 'react'
import { useNews } from '../hooks/useNews'
import { dismissPromo, isPromoDismissed, markPromoShown } from '../lib/promoDismissed'
import { trackAction } from '../lib/telemetry'

const DAY_MS = 86_400_000
// Re-check at least hourly; also keeps setTimeout below its ~24.8-day overflow.
const MAX_WAIT_MS = 3_600_000

/**
 * End of the promotion window in epoch ms, mirroring the backend: a bare
 * YYYY-MM-DD runs through the end of that UTC day. Undefined = no end.
 */
function promoEndMs(endsAt?: string): number | undefined {
  if (!endsAt) return undefined
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(endsAt) ? Date.parse(`${endsAt}T00:00:00Z`) + DAY_MS : Date.parse(endsAt)
  return Number.isNaN(ms) ? undefined : ms
}

/**
 * Floating bottom-right banner for the product feed's time-sensitive
 * `promotion`. Slides in after `delayMs`, and once closed (✕, Escape inside it,
 * or following its link) stays hidden for that promotion id. A promotion with
 * a new id shows again.
 */
export function PromoBanner({ delayMs = 1000 }: { delayMs?: number }) {
  const { data } = useNews()
  const promo = data?.promotion ?? null
  // Closed in this session: hides at once, independent of storage availability.
  const [closedId, setClosedId] = useState<string | null>(null)
  const [shown, setShown] = useState(false)
  const asideRef = useRef<HTMLElement>(null)
  // Bumped by a timer so an open tab re-checks endsAt without a refetch.
  const [tick, setTick] = useState(0)

  const endMs = promoEndMs(promo?.endsAt)
  const expired = endMs !== undefined && Date.now() >= endMs

  useEffect(() => {
    if (endMs === undefined || Date.now() >= endMs) return
    const t = setTimeout(() => setTick((n) => n + 1), Math.min(endMs - Date.now(), MAX_WAIT_MS))
    return () => clearTimeout(t)
  }, [endMs, tick])

  const visible = promo !== null && !expired && promo.id !== closedId && !isPromoDismissed(promo.id)
  const visibleId = visible ? promo.id : null

  useEffect(() => {
    if (!visibleId) return
    const t = setTimeout(() => {
      setShown(true)
      // Count it once it is actually on screen, and once per tab (not per remount).
      if (markPromoShown(visibleId)) trackAction('promo_shown', { id: visibleId })
    }, delayMs)
    return () => {
      clearTimeout(t)
      setShown(false)
    }
  }, [visibleId, delayMs])

  if (!visible) return null

  const close = (action: 'promo_dismiss' | 'promo_click') => {
    // Closing unmounts the focused control; hand keyboard focus to the page content.
    const hadFocus = asideRef.current?.contains(document.activeElement) ?? false
    dismissPromo(promo.id)
    setClosedId(promo.id)
    trackAction(action, { id: promo.id })
    if (hadFocus && action === 'promo_dismiss') document.querySelector<HTMLElement>('main')?.focus()
  }

  return (
    <aside
      ref={asideRef}
      className={shown ? 'promo show' : 'promo'}
      // Invisible during the entrance delay: keep it out of the tab order and a11y tree.
      inert={!shown}
      aria-label="Promotion"
      onKeyDown={(e) => {
        if (e.key === 'Escape') close('promo_dismiss')
      }}
    >
      <div className="promo-body">
        <div className="promo-title">{promo.title}</div>
        {promo.text && <div className="promo-text">{promo.text}</div>}
        <a
          className="celllink promo-link"
          href={promo.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => close('promo_click')}
        >
          {promo.cta} ↗
        </a>
      </div>
      <button type="button" className="promo-close" aria-label="Dismiss promotion" onClick={() => close('promo_dismiss')}>
        ✕
      </button>
    </aside>
  )
}
