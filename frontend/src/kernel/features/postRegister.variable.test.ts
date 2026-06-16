import { describe, it, expect } from 'vitest'
import { initGlobalRepo } from '../query'
import { postRegister } from './postRegister'

describe('postRegister variable', () => {
  it('registers the value by feature id and by label', () => {
    const repo = initGlobalRepo()
    const feature = { id: 'v1', kind: 'variable', label: 'width' }
    postRegister(repo, 'v1', feature, { status: 'ok', value: 100, expression: '100' })

    const payload = { type: 'variable', value: 100, expression: '100', label: 'width' }
    expect(repo.elements.get('_var_v1')).toEqual(payload)
    expect(repo.elements.get('width')).toEqual(payload)
  })

  it('does not register when the result carries no value', () => {
    const repo = initGlobalRepo()
    const feature = { id: 'v1', kind: 'variable', label: 'width' }
    postRegister(repo, 'v1', feature, { status: 'exception', exception: 'boom' })
    expect(repo.elements.get('_var_v1')).toBeUndefined()
    expect(repo.elements.get('width')).toBeUndefined()
  })
})
