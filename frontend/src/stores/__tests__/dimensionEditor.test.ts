import { describe, it, expect } from 'vitest'
import { dimensionEditorIcon, formatDimensionInput } from '@/stores/dimensionEditor'
import { CONSTRAINT_BY_KIND } from '@/registry/constraintRegistry'
import { TOOL_DEFS } from '@/components/Toolbar/tools/toolsConfig'
import { iconUrl } from '@/components/Toolbar/tools/toolUtils'

describe('formatDimensionInput', () => {
  it('shows at most five decimals with trailing zeros trimmed', () => {
    expect(formatDimensionInput(2.459687246427)).toBe('2.45969')
    expect(formatDimensionInput(2.46)).toBe('2.46')
    expect(formatDimensionInput(90)).toBe('90')
    expect(formatDimensionInput(12345.12345)).toBe('12345.12345')
  })

  it('rounds a value finer than the box can show to a plain zero', () => {
    expect(formatDimensionInput(1e-7)).toBe('0')
    expect(formatDimensionInput(0)).toBe('0')
  })

  it('keeps a negative sign', () => {
    expect(formatDimensionInput(-12345.12345)).toBe('-12345.12345')
    expect(formatDimensionInput(-2.5)).toBe('-2.5')
  })
})

describe('dimensionEditorIcon', () => {
  const toolIcon = iconUrl(TOOL_DEFS.dimension.icon)

  it('falls back to the dimension tool icon for every linear kind', () => {
    for (const kind of ['length', 'radius', 'diameter', 'point_distance', 'point_distance_x', 'point_distance_y', 'line_distance']) {
      expect(dimensionEditorIcon(kind), kind).toBe(toolIcon)
    }
  })

  it('uses the angular icon the registry names for an angle', () => {
    expect(CONSTRAINT_BY_KIND.get('angle')?.dimensionIcon).toBe('dimension-angle')
    expect(dimensionEditorIcon('angle')).toBe(iconUrl('dimension-angle'))
    expect(dimensionEditorIcon('angle')).not.toBe(toolIcon)
  })

  it('falls back to the tool icon for a kind with no override and for an unknown kind', () => {
    expect(dimensionEditorIcon(undefined)).toBe(toolIcon)
    expect(dimensionEditorIcon('not_a_constraint')).toBe(toolIcon)
    // Only angle overrides today: a future angular kind sets the field, every
    // other kind keeps the tool glyph with no code change.
    for (const def of CONSTRAINT_BY_KIND.values()) {
      if (def.kind === 'angle') continue
      expect(def.dimensionIcon, def.kind).toBeUndefined()
    }
  })
})
