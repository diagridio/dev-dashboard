function legacyCopy(t: string): void {
  const ta = document.createElement('textarea')
  ta.value = t
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  document.execCommand('copy')
  document.body.removeChild(ta)
}

export function copyText(t: string): void {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(t).catch(() => legacyCopy(t))
  } else {
    legacyCopy(t)
  }
}
