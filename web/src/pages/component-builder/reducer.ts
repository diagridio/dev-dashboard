import { defaultComponentSpec, type ComponentSpec } from '../../types/component'
import type { ComponentMetadataSchema, AuthenticationProfile, MetadataField } from '../../types/metadata'
import { validateResourceName } from '../../lib/validation'
import { activeFields } from '../../hooks/useComponentSchemas'

export interface ComponentBuilderState {
  activeStep: number
  category?: string
  schema?: ComponentMetadataSchema
  version: string
  authProfile?: AuthenticationProfile
  hasAuthProfiles: boolean
  name: string
  namespace: string
  values: Record<string, string>
  secretRefs: Record<string, { name: string; key: string }>
  useSecret: Record<string, boolean>
  optionalAdded: string[]
}

export type Action =
  | { type: 'SELECT_SCHEMA'; schema: ComponentMetadataSchema; version: string }
  | { type: 'SET_AUTH_PROFILE'; profile?: AuthenticationProfile }
  | { type: 'SET_NAME'; name: string }
  | { type: 'SET_NAMESPACE'; namespace: string }
  | { type: 'SET_VALUE'; field: string; value: string }
  | { type: 'TOGGLE_SECRET'; field: string; on: boolean }
  | { type: 'SET_SECRET'; field: string; ref: { name: string; key: string } }
  | { type: 'ADD_OPTIONAL'; field: string }
  | { type: 'REMOVE_OPTIONAL'; field: string }
  | { type: 'SELECT_CATEGORY'; category: string }
  | { type: 'NEXT' }
  | { type: 'BACK' }

export function initialState(): ComponentBuilderState {
  return {
    activeStep: 0,
    version: '',
    hasAuthProfiles: false,
    name: '',
    namespace: 'default',
    values: {},
    secretRefs: {},
    useSecret: {},
    optionalAdded: [],
  }
}

export function reducer(state: ComponentBuilderState, action: Action): ComponentBuilderState {
  switch (action.type) {
    case 'SELECT_SCHEMA': {
      const hasAuthProfiles = (action.schema.authenticationProfiles?.length ?? 0) > 0
      const sameSchema = action.schema.type === state.schema?.type && action.schema.name === state.schema?.name
      if (sameSchema) {
        return {
          ...state,
          category: action.schema.type,
          schema: action.schema,
          version: action.version,
          hasAuthProfiles,
          activeStep: 1,
        }
      }
      // Switching component invalidates the auth profile + its config.
      return {
        ...state,
        category: action.schema.type,
        schema: action.schema,
        version: action.version,
        hasAuthProfiles,
        activeStep: 1,
        authProfile: undefined,
        values: {},
        secretRefs: {},
        useSecret: {},
        optionalAdded: [],
      }
    }
    case 'SELECT_CATEGORY':
      if (action.category === state.schema?.type) {
        return { ...state, category: action.category }
      }
      // Switching category invalidates the chosen component + its config.
      return {
        ...state,
        category: action.category,
        schema: undefined,
        version: '',
        authProfile: undefined,
        hasAuthProfiles: false,
        values: {},
        secretRefs: {},
        useSecret: {},
        optionalAdded: [],
      }
    case 'SET_AUTH_PROFILE':
      return { ...state, authProfile: action.profile }
    case 'SET_NAME':
      return { ...state, name: action.name }
    case 'SET_NAMESPACE':
      return { ...state, namespace: action.namespace }
    case 'SET_VALUE':
      return { ...state, values: { ...state.values, [action.field]: action.value } }
    case 'TOGGLE_SECRET':
      return { ...state, useSecret: { ...state.useSecret, [action.field]: action.on } }
    case 'SET_SECRET':
      return { ...state, secretRefs: { ...state.secretRefs, [action.field]: action.ref } }
    case 'ADD_OPTIONAL':
      return state.optionalAdded.includes(action.field)
        ? state
        : { ...state, optionalAdded: [...state.optionalAdded, action.field] }
    case 'REMOVE_OPTIONAL': {
      const values = { ...state.values }
      const secretRefs = { ...state.secretRefs }
      const useSecret = { ...state.useSecret }
      delete values[action.field]
      delete secretRefs[action.field]
      delete useSecret[action.field]
      return {
        ...state,
        optionalAdded: state.optionalAdded.filter((f) => f !== action.field),
        values,
        secretRefs,
        useSecret,
      }
    }
    case 'NEXT':
      return { ...state, activeStep: state.activeStep + 1 }
    case 'BACK':
      return { ...state, activeStep: Math.max(0, state.activeStep - 1) }
    default:
      return state
  }
}

// The fields shown on the Configure step: all required + any optional the user added.
function configureFields(state: ComponentBuilderState): MetadataField[] {
  if (!state.schema) return []
  const { required, optional } = activeFields(state.schema, state.authProfile)
  const added = optional.filter((f) => state.optionalAdded.includes(f.name))
  return [...required, ...added]
}

function fieldSatisfied(state: ComponentBuilderState, f: MetadataField): boolean {
  if (state.useSecret[f.name]) {
    const ref = state.secretRefs[f.name]
    return !!ref && ref.name.trim() !== '' && ref.key.trim() !== ''
  }
  return (state.values[f.name] ?? '').trim() !== ''
}

export function canContinue(state: ComponentBuilderState): boolean {
  switch (state.activeStep) {
    case 0:
      return !!state.schema && state.version !== ''
    case 1:
      return true // auth profile optional
    case 2: {
      if (validateResourceName(state.name) !== null) return false
      const required = configureFields(state).filter((f) => f.required)
      return required.every((f) => fieldSatisfied(state, f))
    }
    default:
      return true
  }
}

export function assembleComponentSpec(state: ComponentBuilderState): ComponentSpec {
  const spec = defaultComponentSpec()
  spec.metadata.name = state.name
  if (state.namespace.trim() !== '') spec.metadata.namespace = state.namespace
  spec.spec.type = state.schema ? `${state.schema.type}.${state.schema.name}` : ''
  spec.spec.version = state.version
  const byName = new Map(configureFields(state).map((f) => [f.name, f]))
  spec.spec.metadata = []
  for (const [name, field] of byName) {
    if (state.useSecret[name]) {
      const ref = state.secretRefs[name]
      if (ref && ref.name.trim() && ref.key.trim()) spec.spec.metadata.push({ name, secretKeyRef: ref })
      continue
    }
    const raw = (state.values[name] ?? '').trim()
    if (raw === '') continue
    let value: string | number | boolean = raw
    if (field.type === 'number') { const n = Number(raw); value = Number.isNaN(n) ? raw : n }
    else if (field.type === 'bool') value = raw === 'true'
    spec.spec.metadata.push({ name, value })
  }
  return spec
}
