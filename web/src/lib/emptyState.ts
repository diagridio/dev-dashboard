import { load } from 'js-yaml'
import emptyStatesYamlRaw from '../content/empty-states.yaml?raw'

export interface EmptyStateContent {
  /** Applications page — hint shown when no Dapr apps were discovered. */
  apps: string
}

/**
 * Parsed at module load from the editable YAML content file. Render the copy
 * with `renderCopyLinks` (src/lib/copy-links.tsx) so its markdown-style links
 * become real links.
 */
export const emptyStateContent = load(emptyStatesYamlRaw) as EmptyStateContent
