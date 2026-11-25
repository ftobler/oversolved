// The shader probe runs against a real renderer in the app, but its logic is
// pure: a fake renderer whose program list grows inside render the way a driver
// adds a program the first time a shader runs. No WebGL and no three needed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  attachShaderProbe,
  diffPrograms,
  type ProbeProgram,
  type ShaderProbeRenderer,
} from '@/components/Viewport/shaderProbe'

const program = (name: string, cacheKey: string): ProbeProgram => ({ name, cacheKey })

function fakeGl(initial: ProbeProgram[] = []) {
  const programs = [...initial]
  const render = vi.fn(() => {})
  const gl: ShaderProbeRenderer = { info: { programs }, render }
  return { gl, programs, render }
}

function frame(gl: ShaderProbeRenderer): void {
  gl.render(null, null)
}

describe('diffPrograms', () => {
  it('reports every program when nothing compiled before', () => {
    const a = program('mesh', 'key-a')
    const b = program('edge', 'key-b')
    expect(diffPrograms([], [a, b])).toEqual([a, b])
  })

  it('reports nothing when the cache is unchanged', () => {
    const a = program('mesh', 'key-a')
    expect(diffPrograms([a], [a])).toEqual([])
    expect(diffPrograms([], [])).toEqual([])
  })

  it('reports only the program added among existing ones', () => {
    const keep = program('mesh', 'key-a')
    const added = program('edge', 'key-b')
    expect(diffPrograms([keep], [keep, added])).toEqual([added])
  })

  it('compares identity, not name', () => {
    const first = program('mesh', 'key-1')
    const second = program('mesh', 'key-2')
    // Two programs with one name are two distinct programs, both reported.
    expect(diffPrograms([], [first, second])).toEqual([first, second])
    // A same-named program is still new when a different program with that name
    // was already compiled: this is what rules out a name-based comparison.
    expect(diffPrograms([first], [first, second])).toEqual([second])
    // The same object under the same name is not new the second time.
    expect(diffPrograms([first], [first])).toEqual([])
  })
})

describe('attachShaderProbe', () => {
  let log: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('logs each new program once with its name, key and frame time', () => {
    const { gl, programs, render } = fakeGl()
    const added = program('mesh', 'x'.repeat(120))
    render.mockImplementationOnce(() => { programs.push(added) })
    const detach = attachShaderProbe(gl, 'part')

    frame(gl)

    expect(log).toHaveBeenCalledTimes(1)
    const line = String(log.mock.calls[0][0])
    expect(line).toContain('[shader-probe part]')
    expect(line).toContain('name=mesh')
    // The cache key is truncated to 80 characters so one line stays readable.
    expect(line).toContain(`cacheKey=${'x'.repeat(80)}`)
    expect(line).not.toContain('x'.repeat(81))
    expect(line).toMatch(/frame=\d+(\.\d+)?ms/)
    detach()
  })

  it('reports programs already in the cache only when they are genuinely new', () => {
    const old = program('old', 'old-key')
    const { gl, programs, render } = fakeGl([old])
    const detach = attachShaderProbe(gl, 'assembly')

    render.mockImplementationOnce(() => { programs.push(program('new', 'new-key')) })
    frame(gl)
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0][0])).toContain('name=new')

    // A frame that compiles nothing is silent.
    frame(gl)
    expect(log).toHaveBeenCalledTimes(1)
    detach()
  })

  it('logs two new programs that share a name as two lines', () => {
    const { gl, programs, render } = fakeGl()
    render.mockImplementationOnce(() => {
      programs.push(program('mesh', 'key-1'), program('mesh', 'key-2'))
    })
    const detach = attachShaderProbe(gl, 'part')

    frame(gl)

    expect(log).toHaveBeenCalledTimes(2)
    expect(String(log.mock.calls[0][0])).toContain('cacheKey=key-1')
    expect(String(log.mock.calls[1][0])).toContain('cacheKey=key-2')
    detach()
  })

  it('restores the renderer and stops logging once detached', () => {
    const { gl, programs, render } = fakeGl()
    const detach = attachShaderProbe(gl, 'part')

    render.mockImplementationOnce(() => { programs.push(program('a', 'key-a')) })
    frame(gl)
    expect(log).toHaveBeenCalledTimes(1)

    detach()
    expect(gl.render).toBe(render)

    render.mockImplementationOnce(() => { programs.push(program('b', 'key-b')) })
    frame(gl)
    expect(log).toHaveBeenCalledTimes(1)
  })
})
