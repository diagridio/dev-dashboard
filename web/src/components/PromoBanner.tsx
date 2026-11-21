import { useEffect, useRef, useState } from 'react'
import { useNews } from '../hooks/useNews'
import { dismissPromo, isPromoDismissed } from '../lib/promoDismissed'
import { trackAction } from '../lib/telemetry'

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
  const trackedId = useRef<string | null>(null)

  const visible = promo !== null && promo.id !== closedId && !isPromoDismissed(promo.id)
  const visibleId = visible ? promo.id : null

  useEffect(() => {
    if (!visibleId) return
    if (trackedId.current !== visibleId) {
      trackedId.current = visibleId
      trackAction('promo_shown', { id: visibleId })
    }
    const t = setTimeout(() => setShown(true), delayMs)
    return () => {
      clearTimeout(t)
      setShown(false)
    }
  }, [visibleId, delayMs])

  if (!visible) return null

  const close = (action: 'promo_dismiss' | 'promo_click') => {
    dismissPromo(promo.id)
    setClosedId(promo.id)
    trackAction(action, { id: promo.id })
  }

  return (
    <aside
      className={shown ? 'promo show' : 'promo'}
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
