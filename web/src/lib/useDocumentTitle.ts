import { useEffect, useRef } from 'react'

export function useDocumentTitle(title: string): void {
  const prevTitleRef = useRef<string>(document.title)

  useEffect(() => {
    const prev = prevTitleRef.current
    document.title = title
    return () => {
      document.title = prev
    }
  }, [title])
}
