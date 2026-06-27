import type { LogLevel } from '../types/logs'

/**
 * Parse a log level from a log line.
 * Supports logfmt-style `level=<value>` and bare token prefixes.
 * Case-insensitive. Returns undefined if no level is found.
 */
export function parseLogLevel(line: string): LogLevel | undefined {
  const lower = line.toLowerCase()

  // logfmt: level=error|warn|warning|info|debug
  const logfmtMatch = lower.match(/\blevel=(error|warn|warning|info|debug)\b/)
  if (logfmtMatch) {
    const val = logfmtMatch[1]
    if (val === 'warning') return 'warn'
    return val as LogLevel
  }

  // Bare tokens: ERRO|ERROR|FATA|WARN|INFO|DEBU|DEBUG (word boundaries)
  const tokenMatch = lower.match(/\b(erro|error|fata|warn|info|debu|debug)\b/)
  if (tokenMatch) {
    const val = tokenMatch[1]
    if (val === 'error' || val === 'erro' || val === 'fata') return 'error'
    if (val === 'warn') return 'warn'
    if (val === 'info') return 'info'
    if (val === 'debu' || val === 'debug') return 'debug'
  }

  return undefined
}
