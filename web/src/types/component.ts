export interface ComponentMetadataItem {
  name: string
  value?: string | number | boolean
  secretKeyRef?: { name: string; key: string }
}

export interface ComponentSpec {
  apiVersion: string
  kind: string
  // namespace/scopes are deleted before emit when blank/empty (assembleComponentSpec).
  metadata: { name: string; namespace?: string; [key: string]: unknown }
  scopes?: string[]
  spec: {
    type: string
    version: string
    metadata: ComponentMetadataItem[]
  }
}

export function defaultComponentSpec(): ComponentSpec {
  return {
    apiVersion: 'dapr.io/v1alpha1',
    kind: 'Component',
    metadata: { name: '', namespace: 'default' },
    scopes: [],
    spec: { type: '', version: '', metadata: [] },
  }
}
