// The dots button on a Parts card row opens the parts surface of the context
// menu. The page defaults an omitted surface to the viewport board, so this
// assertion is what keeps a row's menu from silently switching boards.
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { makeCallbacks, renderSidebar, resetStores } from './sidebarTestHarness'

beforeEach(() => {
  resetStores()
})

describe('PartsList context menu surface', () => {
  it('passes the parts surface and the body target from the dots button', () => {
    usePartEditorStore.setState({
      parts: { body_ex1: { id: 'body_ex1', created_by: 'ex1', modified_by: [] } },
      partLabels: { body_ex1: 'Ex One' },
      visibleParts: new Set(['body_ex1']),
    })
    const callbacks = makeCallbacks()
    const { container } = renderSidebar(callbacks)

    fireEvent.click(container.querySelector('.part-context-btn')!)

    expect(callbacks.onRightClick).toHaveBeenCalledWith(expect.any(Array), 'body:body_ex1', 'parts')
  })
})
