import { describe, it, expect } from 'vitest'
import { ledClass, runtimeSwatch } from './runtimeSwatch'

describe('ledClass', () => {
  it('maps healthy to ok', () => {
    expect(ledClass('healthy')).toBe('ok')
  })

  it('maps starting to warn', () => {
    expect(ledClass('starting')).toBe('warn')
  })

  it('maps unhealthy to bad', () => {
    expect(ledClass('unhealthy')).toBe('bad')
  })

  it('maps unknown statuses to warn', () => {
    expect(ledClass('unknown' as never)).toBe('warn')
  })
})

describe('runtimeSwatch', () => {
  it('maps go runtimes to the Go blue', () => {
    expect(runtimeSwatch('go1.22')).toBe('#00ADD8')
  })

  it('maps python runtimes to the Python blue', () => {
    expect(runtimeSwatch('Python 3.12')).toBe('#3776AB')
  })

  it('maps node/js runtimes to the Node green', () => {
    expect(runtimeSwatch('node 20')).toBe('#539E43')
    expect(runtimeSwatch('js')).toBe('#539E43')
  })

  it('maps .net/dotnet runtimes to the .NET purple', () => {
    expect(runtimeSwatch('.NET 8')).toBe('#8330FF')
    expect(runtimeSwatch('dotnet')).toBe('#8330FF')
  })

  it('falls back to the faint CSS variable for unknown runtimes', () => {
    expect(runtimeSwatch('rust')).toBe('var(--faint)')
  })

  it('is case-insensitive', () => {
    expect(runtimeSwatch('GO')).toBe('#00ADD8')
  })
})
