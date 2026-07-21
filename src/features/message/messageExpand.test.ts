import { describe, expect, it } from 'vitest'
import { COMPOSITOR_GRID_TRANSITION } from '../../hooks/useCompositorExpand'
import { chevronClass, expandFadeGridClass, expandGridClass, MSG_EXPAND } from './messageExpand'

describe('messageExpand', () => {
  it('keeps panel transition aligned with compositor desktop path', () => {
    expect(MSG_EXPAND.panel).toBe(COMPOSITOR_GRID_TRANSITION)
  })

  it('builds open and closed grid classes', () => {
    expect(expandGridClass(true)).toBe(`grid ${MSG_EXPAND.panel} grid-rows-[1fr]`)
    expect(expandGridClass(false)).toBe(`grid ${MSG_EXPAND.panel} grid-rows-[0fr]`)
    expect(expandGridClass(true, false)).toBe('grid grid-rows-[1fr]')
    expect(expandGridClass(true, true, 'custom-panel')).toBe('grid custom-panel grid-rows-[1fr]')
  })

  it('builds fade grid and chevron classes', () => {
    expect(expandFadeGridClass(true)).toContain('opacity-100')
    expect(expandFadeGridClass(false)).toContain('opacity-0')
    expect(chevronClass(true)).not.toContain('-rotate-90')
    expect(chevronClass(false)).toContain('-rotate-90')
  })
})
