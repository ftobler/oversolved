// Shared canvas + renderer stubs for the id-buffer dispatch tests. jsdom does
// not lay out elements, so getBoundingClientRect is stubbed to an 800x600
// viewport at the origin; StubRenderer supplies the gl.domElement the
// dispatcher reads.

export class StubRenderer {
  domElement: HTMLCanvasElement
  constructor(canvas: HTMLCanvasElement) { this.domElement = canvas }
}

export function makeCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = 800; c.height = 600
  c.getBoundingClientRect = () => ({
    x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON() { return {} },
  })
  return c
}
