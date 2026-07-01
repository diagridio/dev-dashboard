export interface MetadataField {
  name: string
  type?: 'string' | 'number' | 'bool' | 'duration'
  description?: string
  required?: boolean
  sensitive?: boolean
  default?: string
  example?: string
  allowedValues?: string[]
  isCert?: boolean
  binding?: { input?: boolean; output?: boolean }
  url?: { title: string; url: string }
}

export interface AuthenticationProfile {
  title: string
  description?: string
  metadata: MetadataField[]
}

export interface ComponentMetadataSchema {
  type: string
  name: string
  version: string
  title: string
  status: string
  description?: string
  metadata?: MetadataField[]
  authenticationProfiles?: AuthenticationProfile[]
}

export interface MetadataBundle {
  schemaVersion: string
  date: string
  components: ComponentMetadataSchema[]
}
