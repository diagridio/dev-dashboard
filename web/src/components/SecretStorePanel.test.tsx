import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect } from 'vitest'
import { SecretStorePanel } from './SecretStorePanel'

const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>)

describe('SecretStorePanel', () => {
  it('shows the resolved file and the flattened key names', () => {
    wrap(<SecretStorePanel info={{
      name: 'localsecretstore', type: 'secretstores.local.file',
      file: '/tmp/secrets.json', keys: ['redis:password', 'apiKey'], usedBy: ['statestore'],
    }} />)
    expect(screen.getByText('/tmp/secrets.json')).toBeInTheDocument()
    expect(screen.getByText('redis:password')).toBeInTheDocument()
    expect(screen.getByText('statestore')).toBeInTheDocument()
  })

  it('reports an init failure instead of an empty key list', () => {
    wrap(<SecretStorePanel info={{
      name: 's', type: 'secretstores.local.file',
      file: '/tmp/missing.json', initErr: 'open /tmp/missing.json: no such file or directory',
    }} />)
    expect(screen.getByText(/no such file or directory/)).toBeInTheDocument()
  })

  it('says why keys are not listed for a prefix-less env store', () => {
    wrap(<SecretStorePanel info={{ name: 'envsecrets', type: 'secretstores.local.env' }} />)
    expect(screen.getByText(/set a prefix/i)).toBeInTheDocument()
  })

  it('lists env keys when a prefix is set', () => {
    wrap(<SecretStorePanel info={{
      name: 'envsecrets', type: 'secretstores.local.env', prefix: 'MYAPP_', keys: ['ONE'],
    }} />)
    expect(screen.getByText('ONE')).toBeInTheDocument()
    expect(screen.getByText(/MYAPP_/)).toBeInTheDocument()
  })

  it('states the cap rather than truncating silently', () => {
    wrap(<SecretStorePanel info={{
      name: 's', type: 'secretstores.local.file', file: '/tmp/s.json',
      keys: ['a'], keysCapped: true,
    }} />)
    expect(screen.getByText(/more/i)).toBeInTheDocument()
  })

  it('shows the nested separator and multi-valued rows, with a caption using the actual separator', () => {
    wrap(<SecretStorePanel info={{
      name: 'localsecretstore', type: 'secretstores.local.file',
      file: '/tmp/secrets.json', nestedSeparator: '|', multiValued: false,
      keys: ['redis|password'],
    }} />)
    // the separator value itself, in its own row
    expect(screen.getByText('|')).toBeInTheDocument()
    // multiValued is false, rendered as its own row
    expect(screen.getByText('No')).toBeInTheDocument()
    // the flattening caption must be built from the ACTUAL separator, not a hardcoded ":"
    expect(screen.getByText(/flattened with `\|`/)).toBeInTheDocument()
  })

  it('does not claim flattening applies when multiValued is true; states the multiValued behaviour instead', () => {
    wrap(<SecretStorePanel info={{
      name: 's', type: 'secretstores.local.file', file: '/tmp/s.json',
      nestedSeparator: ':', multiValued: true, keys: ['redis'],
    }} />)
    expect(screen.getByText('Yes')).toBeInTheDocument()
    // must NOT contradict the store's actual mode by claiming keys are flattened
    expect(screen.queryByText(/flattened/i)).not.toBeInTheDocument()
    expect(screen.getByText(/each top-level key is itself a secret/i)).toBeInTheDocument()
  })
})
