import { describe, expect, it } from 'vitest'
import { keyToCommand } from './keys'

const down = (key: string, repeat = false) => keyToCommand({ key, repeat }, true)
const up = (key: string) => keyToCommand({ key, repeat: false }, false)

describe('keyToCommand', () => {
  it.each([
    [' ', 'jump'], ['ArrowUp', 'jump'], ['w', 'jump'], ['W', 'jump'],
    ['ArrowDown', 'slideStart'], ['s', 'slideStart'],
    ['Enter', 'confirm'], ['Escape', 'cancel'], ['p', 'pause'],
  ])('maps keydown %j to %s', (key, command) => {
    expect(down(key)).toBe(command)
  })

  it('ends a slide on keyup of the slide keys only', () => {
    expect(up('ArrowDown')).toBe('slideEnd')
    expect(up('s')).toBe('slideEnd')
    expect(up('x')).toBeNull()
  })

  it('maps releasing a jump key to jumpEnd', () => {
    for (const key of [' ', 'ArrowUp', 'w', 'W']) expect(keyToCommand({ key, repeat: false }, false)).toBe('jumpEnd')
  })

  it('ignores auto-repeat keydowns', () => {
    expect(down(' ', true)).toBeNull()
    expect(down('Enter', true)).toBeNull()
    expect(down('ArrowDown', true)).toBeNull()
  })

  it('ignores unrelated keys', () => {
    expect(down('x')).toBeNull()
    expect(down('Tab')).toBeNull()
  })
})
