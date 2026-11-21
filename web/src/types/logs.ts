export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

export interface LogLine {
  seq: number
  text: string
  level?: LogLevel
}

export interface NewsItem {
  title: string
  url: string
  excerpt?: string
  publishedAt?: string
  eventStartDate?: string
  eventLocation?: string
}

export interface NewsResponse {
  blog: NewsItem | null
  report: NewsItem | null
  webinar: NewsItem | null
  event: NewsItem | null
  /** Time-sensitive item for the floating promotion banner; null when none. */
  promotion?: Promotion | null
}

/** Feed promotion (already filtered to its time window by the backend). */
export interface Promotion {
  id: string
  title: string
  text?: string
  url: string
  cta: string
  startsAt?: string
  endsAt?: string
}
