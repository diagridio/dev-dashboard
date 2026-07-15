import { load } from 'js-yaml'
import shareYamlRaw from '../content/share.yaml?raw'

export const REPO_URL = 'https://github.com/diagridio/dev-dashboard'

export interface ShareContent {
  emailSubject: string
  fullMessage: string
  shortX: string
  shortBluesky: string
}

/** Parsed at module load from the editable YAML content file. */
export const shareContent = load(shareYamlRaw) as ShareContent

export type ShareChannel = 'copy' | 'email' | 'x' | 'linkedin' | 'bluesky'

/** mailto: with prefilled subject + full message body. */
export function emailUrl(): string {
  const subject = encodeURIComponent(shareContent.emailSubject)
  const body = encodeURIComponent(shareContent.fullMessage)
  return `mailto:?subject=${subject}&body=${body}`
}

/** X intent — short text plus repo URL as a separate param. */
export function xUrl(): string {
  const text = encodeURIComponent(shareContent.shortX)
  const url = encodeURIComponent(REPO_URL)
  return `https://x.com/intent/tweet?text=${text}&url=${url}`
}

/** BlueSky compose intent — repo URL appended to the text (no url param). */
export function blueskyUrl(): string {
  const text = encodeURIComponent(`${shareContent.shortBluesky}\n${REPO_URL}`)
  return `https://bsky.app/intent/compose?text=${text}`
}

/** LinkedIn share — URL only; LinkedIn ignores prefilled text. */
export function linkedinUrl(): string {
  return `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(REPO_URL)}`
}
