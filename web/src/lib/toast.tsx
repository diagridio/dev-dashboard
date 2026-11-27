import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

// ---------- tiny toast ----------
// One toast for the whole app. <ToastProvider> is mounted once in App.tsx,
// inside .app where the theme tokens live, and renders the single toast.
// useToast() sends messages to it, so a new message replaces the one showing
// instead of stacking a second toast on top. Modal mounts its own provider so a
// copy inside a dialog is announced from inside the aria-modal dialog.
//
// Usage:
//   const { toast, toastNode } = useToast()
//   toast.show('Copied!')
//   return <>{/* ... */}{toastNode}</>
//
// Under the provider, toastNode renders nothing. Without a provider (isolated
// component tests) useToast falls back to a local toast that toastNode renders.

export interface ToastHandle {
  show: (text: string) => void
}

const HIDE_AFTER_MS = 1400

/** Message state plus the hide timer, shared by the provider and the fallback. */
function useToastState(): { msg: string | null; toast: ToastHandle } {
  const [msg, setMsg] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const show = useCallback((text: string) => {
    setMsg(text)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setMsg(null), HIDE_AFTER_MS)
  }, [])

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )

  const toast = useMemo(() => ({ show }), [show])
  return { msg, toast }
}

const ToastContext = createContext<ToastHandle | null>(null)

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const { msg, toast } = useToastState()
  return (
    <ToastContext.Provider value={toast}>
      {children}
      <Toast msg={msg} />
    </ToastContext.Provider>
  )
}

export function useToast(): { toast: ToastHandle; toastNode: React.ReactElement } {
  const shared = useContext(ToastContext)
  // Always call the local hook so the hook order never depends on the provider.
  const local = useToastState()
  if (shared) return { toast: shared, toastNode: <></> }
  return { toast: local.toast, toastNode: <Toast msg={local.msg} /> }
}

export function Toast({ msg }: { msg: string | null }) {
  return (
    <div className={`toast${msg ? ' show' : ''}`} aria-live="polite">
      <span className="d" />
      <span className="tx">{msg ?? ''}</span>
    </div>
  )
}
