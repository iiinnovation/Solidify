import { describe, it, expect } from 'vitest'
import { cn } from './utils'

describe('cn', () => {
  it('should merge class names', () => {
    const result = cn('foo', 'bar')

    expect(result).toBe('foo bar')
  })

  it('should handle conditional classes', () => {
    const result = cn('foo', false && 'bar', 'baz')

    expect(result).toBe('foo baz')
  })

  it('should merge tailwind classes correctly', () => {
    const result = cn('px-2 py-1', 'px-4')

    // twMerge should keep only the last px class
    expect(result).toBe('py-1 px-4')
  })

  it('should handle arrays', () => {
    const result = cn(['foo', 'bar'], 'baz')

    expect(result).toBe('foo bar baz')
  })

  it('should handle objects', () => {
    const result = cn({ foo: true, bar: false, baz: true })

    expect(result).toBe('foo baz')
  })

  it('should handle empty input', () => {
    const result = cn()

    expect(result).toBe('')
  })

  it('should handle undefined and null', () => {
    const result = cn('foo', undefined, null, 'bar')

    expect(result).toBe('foo bar')
  })
})
