import { describe, it, expect, beforeEach } from 'vitest'
import { DOM_HANDLE_ATTRIBUTE, scanDomHandles } from '../domHandles'
import {
  publishProbeCamera, publishProbeCanvas, replaceProbeSource, getSceneHandles, resetSceneProbeStore,
} from '../sceneProbeStore'
import type { ProbeCamera } from '../sceneProbe'
import { FEATURE_HANDLE_LAYER_NAME } from '../layerNames'

/**
 * DOM handles are found by one attribute scan, so the toolbar and tree only
 * have to carry the attribute; nothing has to register or clean up. The probe
 * merges them with the GL handles it already publishes.
 */

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left, top, width, height, right: left + width, bottom: top + height, x: left, y: top,
    toJSON: () => ({}),
  } as DOMRect
}

function stubRect(el: Element, r: DOMRect): void {
  el.getBoundingClientRect = () => r
}

beforeEach(() => {
  document.body.innerHTML = ''
  resetSceneProbeStore()
})

describe('scanDomHandles', () => {
  it('returns attributed elements in document order with their client rects', () => {
    document.body.innerHTML = `
      <div>
        <button ${DOM_HANDLE_ATTRIBUTE}="toolbar:set_tool_line">Line</button>
        <span>no handle</span>
        <button ${DOM_HANDLE_ATTRIBUTE}="toolbar:undo">Undo</button>
      </div>
    `
    const buttons = document.body.querySelectorAll('button')
    stubRect(buttons[0], rect(10, 20, 30, 40))
    stubRect(buttons[1], rect(50, 60, 70, 80))

    expect(scanDomHandles(document)).toEqual([
      { handle: 'toolbar:set_tool_line', rect: [10, 20, 30, 40] },
      { handle: 'toolbar:undo', rect: [50, 60, 70, 80] },
    ])
  })

  it('skips an empty attribute value', () => {
    document.body.innerHTML = `<button ${DOM_HANDLE_ATTRIBUTE}="">empty</button>`
    expect(scanDomHandles(document)).toEqual([])
  })

  it('scans from the given root only, not the whole document', () => {
    document.body.innerHTML = `
      <section id="a"><button ${DOM_HANDLE_ATTRIBUTE}="toolbar:a">A</button></section>
      <section id="b"><button ${DOM_HANDLE_ATTRIBUTE}="toolbar:b">B</button></section>
    `
    const a = document.getElementById('a')!
    stubRect(a.querySelector('button')!, rect(1, 2, 3, 4))
    expect(scanDomHandles(a).map(h => h.handle)).toEqual(['toolbar:a'])
  })
})

describe('getSceneHandles', () => {
  const camera: ProbeCamera = {
    position: [0, 0, 0],
    orientation: [0, 0, 0, 1],
    zoom: 1,
    projectionMatrix: [
      1 / 400, 0, 0, 0,
      0, 1 / 300, 0, 0,
      0, 0, -1 / 500, 0,
      0, 0, 0, 1,
    ],
  }

  it('merges GL handles from the probe with DOM handles, filtered by prefix', () => {
    publishProbeCamera(camera)
    publishProbeCanvas(800, 600)
    replaceProbeSource('fhandle:F1', [{
      pickKey: 'fhandle:F1:depth',
      entityKey: 'fhandle:F1:depth',
      layer: FEATURE_HANDLE_LAYER_NAME,
      kind: 'polyline',
      points: [[0, 0, 0], [0, 10, 0]],
    }])
    document.body.innerHTML = `
      <button ${DOM_HANDLE_ATTRIBUTE}="toolbar:undo">Undo</button>
      <li ${DOM_HANDLE_ATTRIBUTE}="tree:feature:sk1">sk1</li>
    `
    stubRect(document.body.querySelector('button')!, rect(1, 1, 2, 2))
    stubRect(document.body.querySelector('li')!, rect(3, 3, 4, 4))

    const all = getSceneHandles()
    expect(all.map(h => h.handle)).toEqual(['fhandle:F1:depth', 'toolbar:undo', 'tree:feature:sk1'])
    expect(all[0]).toEqual({
      kind: 'gl',
      handle: 'fhandle:F1:depth',
      entityKey: 'fhandle:F1:depth',
      layer: FEATURE_HANDLE_LAYER_NAME,
      screenPoints: [[400, 300], [400, 290]],
    })
    expect(all[1]).toEqual({ kind: 'dom', handle: 'toolbar:undo', rect: [1, 1, 2, 2] })

    expect(getSceneHandles('tree:').map(h => h.handle)).toEqual(['tree:feature:sk1'])
    expect(getSceneHandles('nope:')).toEqual([])
  })
})
