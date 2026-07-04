import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

// ---------- tiny toast ----------
// Shared toast utility used by AppDetail and other pages (e.g. copy-YAML flows).
//
// Usage:
//   const { toast, toastNode } = useToast()
//   toast.show('Copied!')
//   return <>{/* ... */}{toastNode}</>

export interface ToastHandle {
  show: (text: string) => void
}

export function useToast(): { toast: ToastHandle; toastNode: React.ReactElement } {
  const [msg, setMsg] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const show = useCallback((text: string) => {
    setMsg(text)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setMsg(null), 1400)
  }, [])

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )

  const toast = useMemo(() => ({ show }), [show])
  const toastNode = <Toast msg={msg} />
  return { toast, toastNode }
}

export function Toast({ msg }: { msg: string | null }) {
  return (
    <div className={`toast${msg ? ' show' : ''}`} aria-live="polite">
      <span className="d" />
      <span className="tx">{msg ?? ''}</span>
    </div>
  )
}
