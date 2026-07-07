import { useEffect, useRef } from 'react'

const TITLE_SUFFIX = ' | Diagrid Dev Dashboard'

export function useDocumentTitle(title: string): void {
  const prevTitleRef = useRef<string>(document.title)

  useEffect(() => {
    const prev = prevTitleRef.current
    document.title = `${title}${TITLE_SUFFIX}`
    return () => {
      document.title = prev
    }
  }, [title])
}
