import type { ReactNode } from 'react'
import { getCapabilities } from '../lib/capabilities'

/**
 * Where resource pages read their YAML from. On the host that is
 * page-specific (`host`, e.g. ~/.dapr/components and --resources-path args);
 * in container posture it is only the folders mounted into the dashboard
 * container and listed in DEVDASHBOARD_RESOURCES_PATH.
 */
export function ResourceSources({ host }: { host: ReactNode }) {
  if (getCapabilities().containerPosture === true) {
    return (
      <>
        the folders mounted via <span className="mono">DEVDASHBOARD_RESOURCES_PATH</span>
      </>
    )
  }
  return <>{host}</>
}
