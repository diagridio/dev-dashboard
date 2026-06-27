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
}
