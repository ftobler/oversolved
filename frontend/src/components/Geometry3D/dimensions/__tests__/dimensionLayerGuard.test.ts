import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

/**
 * Every piece of dimension geometry has to take its layer from
 * dimensionRenderLayer(). depthTest: false alone is not "on top": three sorts
 * opaque objects by material.id when the renderOrders tie, so a body remounted
 * after the dimension materials paints over them. This guard is the ratchet
 * for the next primitive: a <Line> or <mesh> in this folder that does not name
 * a renderOrder (directly or through the layer helper) fails here instead of
 * showing up as a line hidden behind a body.
 */

const DIR = join(__dirname, '..')

function offendingLines(source: string): string[] {
  const out: string[] = []
  for (const [i, line] of source.split('\n').entries()) {
    if (!/<(?:Line|mesh|DashedLine)\b/.test(line)) continue
    if (/renderOrder|dimensionRenderLayer/.test(line)) continue
    out.push(`${i + 1}: ${line.trim()}`)
  }
  return out
}

function sourceFiles(): string[] {
  return readdirSync(DIR, { withFileTypes: true })
    .filter(e => e.isFile() && (e.name.endsWith('.tsx') || e.name.endsWith('.ts')))
    .map(e => e.name)
}

describe('dimension geometry render layer', () => {
  it('every <Line>, <DashedLine> and <mesh> under dimensions/ names its render layer', () => {
    const scanned = sourceFiles()
      .flatMap(name => readFileSync(join(DIR, name), 'utf8').split('\n'))
      .filter(line => /<(?:Line|mesh|DashedLine)\b/.test(line))

    // The guard is worthless if the folder layout moved out from under it.
    expect(scanned.length).toBeGreaterThan(0)

    const offenders = sourceFiles()
      .flatMap(name => offendingLines(readFileSync(join(DIR, name), 'utf8')).map(o => `${name}:${o}`))
    expect(offenders).toEqual([])
  })

  it('flags a bare depthTest={false} line, and accepts one with the layer', () => {
    const bare = [
      '  <Line points={pts} color={color} depthTest={false} />',
      '  <mesh position={pos}>',
      '  <DashedLine points={pts} depthTest={false} />',
      '  <Line points={pts} color={color} {...dimensionRenderLayer()} />',
      '  <mesh position={pos} renderOrder={layer.renderOrder}>',
      '  <DashedLine points={pts} renderOrder={layer.renderOrder} depthTest={false} />',
    ].join('\n')

    expect(offendingLines(bare)).toEqual([
      '1: <Line points={pts} color={color} depthTest={false} />',
      '2: <mesh position={pos}>',
      '3: <DashedLine points={pts} depthTest={false} />',
    ])
  })
})
