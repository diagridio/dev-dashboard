import { konamiLabel } from '../hooks/useKonami'

/** A quiet hint at the REPLAY easter egg, spelled from the same sequence useKonami listens for. */
export function KonamiHint() {
  return (
    <p className="konami-hint" aria-label="Konami code">
      {konamiLabel()}
    </p>
  )
}
