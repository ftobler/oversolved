// The analysis material: a patch over the body's normal material rather than a
// second material instance. Swapping instances per toggle would leak one
// compiled program per body on every flip, and the highlight painter writes the
// `color` attribute on the geometry, not on the material, so the SAME material
// has to read it in both modes.
//
// The patch runs after `normal_fragment_begin` because that include is what
// defines the view-space `normal` the zebra reflection needs. Values that move
// while the mode stays on (stripe count, base colour, curvature range) are
// uniforms, so a slider never recompiles a shader; only the mode itself changes
// `customProgramCacheKey`.
import { useEffect, useMemo } from 'react'
import type { RefObject } from 'react'
import * as THREE from 'three'
import type { WebGLProgramParametersWithUniforms } from 'three'
import type { CurvatureKind } from '@/adapters/preferences'

export type BodyAnalysisMode = 'none' | 'zebra' | 'curvature'

export interface BodyAnalysisPatch {
  onBeforeCompile: (shader: WebGLProgramParametersWithUniforms) => void
  customProgramCacheKey: () => string
  uniforms: {
    uStripeFrequency: { value: number }
    uBaseColor?: { value: THREE.Color }
    uCurvatureRange?: { value: THREE.Vector2 }
    uCurvatureKind?: { value: number }
  }
  // Named for the dropdown and for tests; it is also the material's `name`.
  name: string
  setStripeCount?: (value: number) => void
  setBaseColor?: (hex: string) => void
  setCurvature?: (kind: CurvatureKind, range: [number, number]) => void
}

// How much a vertex colour has to move before it counts as a highlight. The
// painter writes exact palette RGB values, so the base colour matches to float
// error and a hover/selection is far outside this.
const HIGHLIGHT_EPSILON = 0.002

// The stripes come from the reflected view direction, so a G1 break in the
// surface kinks them and a G0 break jumps them. Black and white are deliberate:
// ACES shifts them, but it cannot hide a discontinuity.
export const ZEBRA_GLSL = `
  vec3 zebraViewDir = normalize( vViewPosition );
  vec3 zebraReflect = reflect( -zebraViewDir, normal );
  float zebraWave = sin( dot( zebraReflect, vec3( 0.0, 1.0, 0.0 ) ) * uStripeFrequency );
  vec3 zebraColor = mix( vec3( 0.02 ), vec3( 1.0 ), smoothstep( -0.25, 0.25, zebraWave ) );
`

/** The highlight half of the zebra patch, split out because the assembly has no
 *  vertex-colour highlight (its selection is an overlay) and must not reference
 *  an attribute it never uploads. */
export const ZEBRA_HIGHLIGHT_GLSL = `
  float zebraHighlight = step( ${HIGHLIGHT_EPSILON}, distance( vColor, uBaseColor ) );
  diffuseColor.rgb = mix( zebraColor, vColor, zebraHighlight );
`

/**
 * One zebra program. The class exists so the live uniform writes happen through
 * methods on a stable object rather than by reaching into a memo result from an
 * effect: the uniforms are the patch's mutable channel and the object is the
 * owner of that channel.
 */
export class ZebraProgram implements BodyAnalysisPatch {
  readonly name = 'zebra-material'
  readonly uniforms: BodyAnalysisPatch['uniforms']
  private readonly mixVertexColor: boolean

  constructor(mixVertexColor: boolean) {
    this.mixVertexColor = mixVertexColor
    this.uniforms = {
      uStripeFrequency: { value: 12 },
      ...(mixVertexColor ? { uBaseColor: { value: new THREE.Color('#ffffff') } } : {}),
    }
  }

  customProgramCacheKey = (): string => `zebra-${this.mixVertexColor ? 'vc' : 'plain'}`

  setStripeCount = (value: number): void => { this.uniforms.uStripeFrequency.value = value }

  setBaseColor = (hex: string): void => { this.uniforms.uBaseColor?.value.set(hex) }

  onBeforeCompile = (shader: WebGLProgramParametersWithUniforms): void => {
    const declarations = 'uniform float uStripeFrequency;\n'
      + (this.mixVertexColor ? 'uniform vec3 uBaseColor;\n' : '')
    const body = ZEBRA_GLSL + (this.mixVertexColor ? ZEBRA_HIGHLIGHT_GLSL : '  diffuseColor.rgb = zebraColor;\n')
    shader.uniforms.uStripeFrequency = this.uniforms.uStripeFrequency
    if (this.mixVertexColor && this.uniforms.uBaseColor) shader.uniforms.uBaseColor = this.uniforms.uBaseColor
    shader.fragmentShader = declarations + shader.fragmentShader
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_begin>',
      `#include <normal_fragment_begin>\n${body}`,
    )
  }
}

// A diverging ramp: concave (negative) on the blue side, flat neutral, convex
// (positive) on the red side. The auto range is symmetric, so a plane lands
// exactly on the neutral middle.
export const CURVATURE_GLSL = `
  float curvatureValue = uCurvatureKind < 0.5 ? vCurvature.x : vCurvature.y;
  float curvatureSpan = max( uCurvatureRange.y - uCurvatureRange.x, 1e-9 );
  float curvatureT = clamp( ( curvatureValue - uCurvatureRange.x ) / curvatureSpan, 0.0, 1.0 );
  vec3 curvatureCold = vec3( 0.16, 0.36, 0.86 );
  vec3 curvatureFlat = vec3( 0.70, 0.70, 0.70 );
  vec3 curvatureHot = vec3( 0.90, 0.24, 0.18 );
  vec3 curvatureColor = curvatureT < 0.5
    ? mix( curvatureCold, curvatureFlat, curvatureT * 2.0 )
    : mix( curvatureFlat, curvatureHot, ( curvatureT - 0.5 ) * 2.0 );
`

export const CURVATURE_HIGHLIGHT_GLSL = `
  float curvatureHighlight = step( ${HIGHLIGHT_EPSILON}, distance( vColor, uBaseColor ) );
  diffuseColor.rgb = mix( curvatureColor, vColor, curvatureHighlight );
`

/**
 * The curvature program: a vertex attribute carries the two scalars and the
 * fragment maps the selected one through the range uniform. Like zebra, the
 * range and the kind are uniforms, so changing either repaints without a
 * recompile.
 */
export class CurvatureProgram implements BodyAnalysisPatch {
  readonly name = 'curvature-material'
  readonly uniforms: BodyAnalysisPatch['uniforms']
  private readonly mixVertexColor: boolean

  constructor(mixVertexColor: boolean) {
    this.mixVertexColor = mixVertexColor
    this.uniforms = {
      uStripeFrequency: { value: 12 },
      uCurvatureRange: { value: new THREE.Vector2(-1, 1) },
      uCurvatureKind: { value: 0 },
      ...(mixVertexColor ? { uBaseColor: { value: new THREE.Color('#ffffff') } } : {}),
    }
  }

  customProgramCacheKey = (): string => `curvature-${this.mixVertexColor ? 'vc' : 'plain'}`

  setBaseColor = (hex: string): void => { this.uniforms.uBaseColor?.value.set(hex) }

  setCurvature = (kind: CurvatureKind, range: [number, number]): void => {
    this.uniforms.uCurvatureKind!.value = kind === 'gaussian' ? 1 : 0
    this.uniforms.uCurvatureRange!.value.set(range[0], range[1])
  }

  onBeforeCompile = (shader: WebGLProgramParametersWithUniforms): void => {
    const vertexDeclarations = 'attribute vec2 aCurvature;\nvarying vec2 vCurvature;\n'
    const fragmentDeclarations = 'varying vec2 vCurvature;\nuniform vec2 uCurvatureRange;\nuniform float uCurvatureKind;\n'
      + (this.mixVertexColor ? 'uniform vec3 uBaseColor;\n' : '')
    const body = CURVATURE_GLSL + (this.mixVertexColor ? CURVATURE_HIGHLIGHT_GLSL : '  diffuseColor.rgb = curvatureColor;\n')

    shader.vertexShader = vertexDeclarations + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  vCurvature = aCurvature;',
    )
    shader.fragmentShader = fragmentDeclarations + shader.fragmentShader
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_begin>',
      `#include <normal_fragment_begin>\n${body}`,
    )
    shader.uniforms.uCurvatureRange = this.uniforms.uCurvatureRange!
    shader.uniforms.uCurvatureKind = this.uniforms.uCurvatureKind!
    if (this.mixVertexColor && this.uniforms.uBaseColor) shader.uniforms.uBaseColor = this.uniforms.uBaseColor
  }
}

// The cosmetic thread: a procedural normal map on a tapped bore. The phase
// `s - theta / 2pi` is constant along a right-hand helix advancing one pitch per
// turn, so sin(2pi phase) is a smooth flank profile and its sign tilts the
// normal up or down the bore axis. The angle comes from the interpolated
// (u, v) per fragment, which is continuous across the cylinder seam, and so is
// the analytic phase derivative used for the fade: fwidth of atan2 itself would
// spike on the seam and draw a plain stripe there.
//
// Strength is how far a flank tilts the normal (tuned by eye until the bore
// still reads as a cylinder); root shade is the darkening in the groove.
const THREAD_STRENGTH = '0.55'
const THREAD_ROOT_SHADE = '0.18'

//
// No branch: derivatives are undefined in non-uniform control flow (a 2x2 quad
// straddling the run's end would read garbage), so everything is computed for
// every fragment and the plain wall is a zero mask, not a skipped block. Every
// factor is finite for any input, untapped vertices included (sMax = -1 and a
// zero axis), so a 0 mask can never meet a NaN. The floors are 1e-4 or larger
// so they survive mediump, where 1e-12 flushes to 0 and the untapped wall's
// phase derivative would become 0/0.
//
// Line by line: the phase and its screen derivative; the fade once a pitch is
// under about three pixels (moire); the mask to the tapped run with short end
// fades (sMax <= 0 marks an untapped vertex); the guarded axis; the tilt, where
// faceDirection undoes the back-face flip normal_fragment_begin applied so a
// bore seen from behind (a section view) tilts its flanks the same way; and the
// root darkening, which sells the depth the tilted normal alone cannot.
//
// The string itself carries no comments: some GLSL ES front ends reject
// characters outside the GLSL character set even inside a comment, and a
// refused program silently leaves the plain material.
export const THREAD_GLSL = `
  float threadR2 = max( dot( vThreadCoord.xy, vThreadCoord.xy ), 1e-4 );
  float threadPhase = vThreadCoord.z - atan( vThreadCoord.y, vThreadCoord.x + 1e-4 ) / 6.28318530718;
  vec2 threadDu = vec2( dFdx( vThreadCoord.x ), dFdy( vThreadCoord.x ) );
  vec2 threadDv = vec2( dFdx( vThreadCoord.y ), dFdy( vThreadCoord.y ) );
  vec2 threadDs = vec2( dFdx( vThreadCoord.z ), dFdy( vThreadCoord.z ) );
  vec2 threadDphase = threadDs - ( vThreadCoord.x * threadDv - vThreadCoord.y * threadDu ) / ( threadR2 * 6.28318530718 );
  float threadWidth = abs( threadDphase.x ) + abs( threadDphase.y );
  float threadVisible = 1.0 - smoothstep( 0.15, 0.35, threadWidth );
  threadVisible *= step( 0.0, vThreadCoord.w ) * smoothstep( 0.0, 0.2, vThreadCoord.z )
    * smoothstep( 0.0, 0.2, vThreadCoord.w - vThreadCoord.z );
  float threadAxisLength = length( vThreadAxis );
  threadVisible *= step( 1e-3, threadAxisLength );
  vec3 threadAxis = vThreadAxis / max( threadAxisLength, 1e-3 );
  float threadWave = 6.28318530718 * threadPhase;
  normal = normalize( normal + faceDirection * ${THREAD_STRENGTH} * threadVisible * sin( threadWave ) * threadAxis );
  diffuseColor.rgb *= 1.0 - ${THREAD_ROOT_SHADE} * threadVisible * ( 0.5 - 0.5 * cos( threadWave ) );
`

/**
 * The cosmetic-thread program: the body's own material with the tapped bores
 * shaded, so hover and selection colours, section clipping and transparency
 * keep working on the bore wall. Analysis modes replace it (they must show the
 * true surface), so it is installed only while no analysis mode is on.
 */
export class ThreadProgram implements BodyAnalysisPatch {
  readonly name = 'thread-material'
  readonly uniforms: BodyAnalysisPatch['uniforms'] = { uStripeFrequency: { value: 0 } }

  customProgramCacheKey = (): string => 'thread'

  onBeforeCompile = (shader: WebGLProgramParametersWithUniforms): void => {
    shader.vertexShader = 'attribute vec4 aThreadCoord;\nattribute vec3 aThreadAxis;\n'
      + 'varying vec4 vThreadCoord;\nvarying vec3 vThreadAxis;\n' + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      // View space, the space `normal` lives in at normal_fragment_begin. The
      // axis is a direction along the surface, not a normal, so it takes the
      // model-view matrix (the normal matrix is only equal under uniform scale).
      '#include <begin_vertex>\n  vThreadCoord = aThreadCoord;\n  vThreadAxis = mat3( modelViewMatrix ) * aThreadAxis;',
    )
    shader.fragmentShader = 'varying vec4 vThreadCoord;\nvarying vec3 vThreadAxis;\n' + shader.fragmentShader
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_begin>',
      `#include <normal_fragment_begin>\n${THREAD_GLSL}`,
    )
  }
}

/** A standalone patch for a caller that has no hook (tests, one-off previews). */
export function makeZebraPatch(opts: {
  stripes: number
  baseColor: string
  mixVertexColor: boolean
}): BodyAnalysisPatch {
  const patch = new ZebraProgram(opts.mixVertexColor)
  patch.setStripeCount(opts.stripes)
  patch.setBaseColor(opts.baseColor)
  return patch
}

// Restoring an unpatched material means putting back three's own defaults, not
// merely a no-op closure with the previous key still baked into the program.
const NO_PATCH = () => {}
const NO_KEY = () => ''

export interface BodyAnalysisParams {
  mode: BodyAnalysisMode
  mixVertexColor: boolean
  baseColor: string
  zebraStripes: number
  curvatureKind: CurvatureKind
  curvatureRange: [number, number]
  // The geometry carries thread attributes (a tapped bore). Optional so a
  // caller with no threads (the assembly) never has to say so.
  threaded?: boolean
}

/** Which program a body material runs: an analysis mode wins, since it must
 *  show the true surface; the thread shading is the plain view's patch. */
export function selectBodyPatch(mode: BodyAnalysisMode, mixVertexColor: boolean, threaded: boolean): BodyAnalysisPatch | null {
  if (mode === 'zebra') return new ZebraProgram(mixVertexColor)
  if (mode === 'curvature') return new CurvatureProgram(mixVertexColor)
  if (threaded) return new ThreadProgram()
  return null
}

/**
 * Install the analysis patch on a material and keep its uniforms current.
 * `params.mode` and `params.threaded` are the only compile-time inputs; every
 * other field updates the already compiled program through its uniforms.
 */
export function useBodyAnalysisMaterial(
  materialRef: RefObject<THREE.Material | null>,
  params: BodyAnalysisParams,
): BodyAnalysisPatch | null {
  const { mode, mixVertexColor } = params
  const threaded = params.threaded ?? false
  const patch = useMemo<BodyAnalysisPatch | null>(
    () => selectBodyPatch(mode, mixVertexColor, threaded),
    [mode, mixVertexColor, threaded],
  )

  useEffect(() => {
    patch?.setStripeCount?.(params.zebraStripes)
  }, [patch, params.zebraStripes])

  useEffect(() => {
    patch?.setBaseColor?.(params.baseColor)
  }, [patch, params.baseColor])

  useEffect(() => {
    patch?.setCurvature?.(params.curvatureKind, params.curvatureRange)
  }, [patch, params.curvatureKind, params.curvatureRange])

  useEffect(() => {
    const material = materialRef.current
    if (!material) return
    material.onBeforeCompile = patch?.onBeforeCompile ?? (NO_PATCH as THREE.Material['onBeforeCompile'])
    material.customProgramCacheKey = patch?.customProgramCacheKey ?? NO_KEY
    material.needsUpdate = true
    return () => {
      // The material is about to unmount; leave it in a state a recycled
      // instance would not paint with a stale program.
      material.onBeforeCompile = NO_PATCH as THREE.Material['onBeforeCompile']
      material.customProgramCacheKey = NO_KEY
    }
  }, [materialRef, patch])

  return patch
}

/** The material name the components show: one place for the testable tag. */
export function analysisMaterialName(mode: BodyAnalysisMode): string {
  if (mode === 'zebra') return 'zebra-material'
  if (mode === 'curvature') return 'curvature-material'
  return 'body-material'
}
