import { useEffect, type RefObject } from 'react'

/**
 * Distance (px) from the bottom beyond which a user scroll is treated as
 * "scrolled away" and follow mode disengages.
 */
const SCROLL_THRESHOLD = 24

/**
 * Shared follow/auto-scroll mechanics for log viewers.
 *
 * While `following` is true, pins the scroll container to the bottom whenever
 * `itemCount` changes (new lines arrived) or follow is re-engaged. Returns a
 * scroll handler to attach via `onScroll`: when the user scrolls more than
 * SCROLL_THRESHOLD px away from the bottom while following, `onDisengage`
 * fires so the caller can turn follow off.
 *
 * Zero-height (unlaid-out) elements are ignored in both directions so hidden
 * panes neither jump nor disengage follow.
 */
export function useFollowScroll(
  ref: RefObject<HTMLElement | null>,
  itemCount: number,
  following: boolean,
  onDisengage: () => void,
): () => void {
  // Auto-scroll to bottom when new lines arrive and follow is on
  useEffect(() => {
    if (!following) return
    const el = ref.current
    if (!el) return
    if (el.scrollHeight > 0) {
      el.scrollTop = el.scrollHeight
    }
  }, [ref, itemCount, following])

  function handleScroll() {
    const el = ref.current
    if (!el) return
    if (el.scrollHeight === 0) return
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distFromBottom > SCROLL_THRESHOLD && following) {
      // User scrolled away from the bottom — pause following
      onDisengage()
    }
  }

  return handleScroll
}
