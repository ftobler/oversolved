import { useCallback, useMemo, useRef } from 'react'
import { Line } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import type { Line2 } from 'three-stdlib'
import { getSketchCallback } from '@/stores/sketchEditorStore'
import { linearDimensionSign, lineDistanceSign } from '@/utils/geometry/dimensionNaturalValue'
import { computeLinearArrowLayout, dimensionLineGap, evalExtensionLine } from '@/utils/geometry/dimensionRenderLayout'
import { buildPlaneMatrix } from '@/picking/idRegistrationUtils'
import { dimensionRenderLayer } from '@/components/Geometry3D/constants'
import { Arrowhead, ArrowTail, ExtensionLine } from './primitives'
import { useDimInteraction, useActiveLabelDrag, useDimLabelPointerDown, useDimLabelRegistration } from './useDimInteraction'
import { DimensionLabel } from './DimensionLabel'
import { linearLabelAlongWorldPerPixel, linearLabelAngleDeg, linearLabelWorldPerPixel } from './labelScreenAngle'
import type { DimInteraction } from './useDimInteraction'
import type { PlaneTransform } from '@/types/cad'

// Breathing room either side of the digits, in CSS pixels, so the cut line does
// not touch the glyph block's own padding.
const LABEL_GAP_PADDING_PX = 4

// 0.1 degree is finer than a screen pixel can show and coarse enough that a
// slow orbit does not rewrite the style every frame.
function roundTenth(deg: number): number {
  return Math.round(deg * 10) / 10
}

// The halves and the leader are re-cut in place from useFrame, so a camera move
// never re-renders the overlay. (The arrow tails and extension lines in
// primitives.tsx still write `attributes.position`; that is the endcap template,
// not the endpoints, so their zoom-time resize is inert -- tracked in backlog.)
// A drei Line is a Line2, and its endpoints live in its LineGeometry's
// `instanceStart`/`instanceEnd` interleaved attributes; `position` is only the
// eight-vertex endcap template. `setPositions` is the supported write: it
// rebuilds both instance attributes and recomputes the bounds frustum culling
// reads, so writing it only when the cut changes keeps its allocation off the
// per-frame path.
function showLineSpan(line: Line2 | null, x1: number, y1: number, x2: number, y2: number) {
  if (!line) return
  line.geometry.setPositions([x1, y1, 0, x2, y2, 0])
  line.visible = true
}

// An absent span is not "a collapsed point": the shader normalizes the segment
// direction, and a zero vector turns the endcap maths into NaN. Hide the object
// and leave the last real endpoints in its geometry instead.
function hideLine(line: Line2 | null) {
  if (line) line.visible = false
}

export function LinearDimension({ cid, dim, dimOffset, interaction, planeTransform }: {
  cid: string
  dim: { kind: string; dimKind?: string; p1: [number, number]; p2: [number, number]; normal: [number, number]; value: number; pos?: [number, number]; ext1_line?: [number, number, number, number]; ext2_line?: [number, number, number, number] }
  dimOffset: number
  interaction?: DimInteraction
  planeTransform?: PlaneTransform
}) {
  // Directional distances (point_distance_x / point_distance_y / line_distance)
  // carry an orientation sign; the edit dialog offers a Flip side button that
  // swaps it. The render `kind` is always 'dim_linear', so the originating
  // constraint kind arrives as `dimKind`. Directional extras use it for the
  // side; the edit dialog uses it for the value rule (a zero axis distance or
  // radial gap is a legal constraint). Length leaves it unset and keeps the
  // strictly positive default.
  const dimKind = dim.dimKind
  const isDirectional = dimKind === 'point_distance_x' || dimKind === 'point_distance_y' || dimKind === 'line_distance'
  const onFlip = useCallback(() => {
    if (!interaction || !dimKind) return
    const current = dimKind === 'line_distance'
      ? lineDistanceSign(dim.p1, dim.p2, dim.normal)
      : linearDimensionSign(dimKind, dim.p1, dim.p2)
    getSketchCallback('onMutation')?.({
      type: 'set_constraint_sign', featureId: interaction.featureId, constraintId: cid, sign: -current,
    })
  }, [interaction, cid, dimKind, dim.p1, dim.p2, dim.normal])
  const { color, driven, hovered, title, onOver, onOut, onClick, onDoubleClick, resetDragMoved, isDragged } =
    useDimInteraction(cid, dim.value, interaction, true, isDirectional ? onFlip : undefined, dimKind)
  const activeDragPos = useActiveLabelDrag(cid)

  const [x1, y1] = dim.p1, [x2, y2] = dim.p2
  const nx = dim.normal[0], ny = dim.normal[1]
  const nlen = Math.sqrt(nx * nx + ny * ny) || 1
  const unx = nx / nlen, uny = ny / nlen

  // Anchor = midpoint of the two measured points.
  const anchorX = (x1 + x2) / 2, anchorY = (y1 + y2) / 2

  // Effective label offset: active drag overrides stored pos, which overrides default.
  const effectivePos: [number, number] | undefined = activeDragPos
    ? [activeDragPos[0] - anchorX, activeDragPos[1] - anchorY]
    : dim.pos

  let labelX: number, labelY: number, d1x: number, d1y: number, d2x: number, d2y: number

  if (effectivePos) {
    const [ox, oy] = effectivePos
    labelX = anchorX + ox
    labelY = anchorY + oy
    // Project pos onto normal direction to get the dimension-line perpendicular offset.
    const perpOff = ox * unx + oy * uny
    d1x = x1 + unx * perpOff; d1y = y1 + uny * perpOff
    d2x = x2 + unx * perpOff; d2y = y2 + uny * perpOff
  } else {
    d1x = x1 + unx * dimOffset; d1y = y1 + uny * dimOffset
    d2x = x2 + unx * dimOffset; d2y = y2 + uny * dimOffset
    labelX = (d1x + d2x) / 2; labelY = (d1y + d2y) / 2
  }

  // Determine if the label is inside the dimension line (between d1 and d2).
  // ASCII visualizations (in world coordinates, with d1 on the left, d2 on the right):
  //   Inside:        |<---X--->|
  //     Arrows at boundaries pointing outward, label sits between them.
  //   Outside near d1:   X--->|----|<-
  //     Both arrows point inward, leader line from d1 to label.
  //   Outside near d2:   |---->|<----X
  //     Both arrows point inward, leader line from d2 to label.
  //
  // Note: For parallel lines, the arrows should remain aligned with the dimension line,
  // not skewed or offset. The dimension line (d1->d2) is parallel to the measured line (x1->x2),
  // so arrows should point along the dimension line direction only.
  const { udirX, udirY, tLabel, isInside, dimLen } = computeLinearArrowLayout([d1x, d1y], [d2x, d2y], [labelX, labelY])

  // A zero axis distance or a zero radial gap mounts with d1 === d2. That is a
  // point, not a line: a Line2 whose segment has no direction feeds a zero
  // vector to the endcap maths, so neither half nor a leader is created at all.
  // The arrows still mark the point, and the value stays a label on it.
  const hasLine = dimLen > 0

  const valueText = dim.value % 1 === 0 ? String(dim.value) : dim.value.toFixed(2)
  // Parentheses are the drafting convention for a reference dimension: the
  // number is a measurement, not a value the geometry must satisfy.
  const label = driven ? `(${valueText})` : valueText

  // Extension-line evaluation: each side is evaluated independently. When an
  // entity segment is provided (ext1_line / ext2_line) the extension line is
  // skipped if the dimension-line endpoint projects inside the segment (the
  // dim already touches the entity). Otherwise the line runs from the
  // nearest segment point to the dimension-line endpoint.
  const ext1 = dim.ext1_line ? evalExtensionLine(dim.ext1_line[0], dim.ext1_line[1], dim.ext1_line[2], dim.ext1_line[3], d1x, d1y) : { skip: false, touchX: x1, touchY: y1 }
  const ext2 = dim.ext2_line ? evalExtensionLine(dim.ext2_line[0], dim.ext2_line[1], dim.ext2_line[2], dim.ext2_line[3], d2x, d2y) : { skip: false, touchX: x2, touchY: y2 }

  // The label is a screen-space overlay, so which way its line reads and how
  // much room its glyphs take are camera questions, answered every frame. The
  // sketch plane's matrix puts d1/d2/label in the same world frame the scene
  // group and the ID registration use.
  const camera = useThree(s => s.camera)
  const size = useThree(s => s.size)
  const invalidate = useThree(s => s.invalidate)
  const viewportWidth = size?.width ?? 0
  const viewportHeight = size?.height ?? 0
  const planeMatrix = useMemo(() => buildPlaneMatrix(planeTransform), [planeTransform])

  const textElRef = useRef<HTMLDivElement | null>(null)
  const halfARef = useRef<Line2>(null)
  const halfBRef = useRef<Line2>(null)
  const leaderRef = useRef<Line2>(null)
  // The angle last written to the element, so an unchanged angle does not
  // rewrite the style every frame. NaN forces the first write.
  const lastAngle = useRef(Number.NaN)

  // The rendered angle for the first paint. useFrame keeps it current after
  // that without a state update per orbit frame.
  const angleDeg = useMemo(() => {
    const deg = linearLabelAngleDeg(camera, viewportWidth, viewportHeight, planeMatrix, d1x, d1y, d2x, d2y)
    return deg === null ? undefined : roundTenth(deg)
  }, [camera, viewportWidth, viewportHeight, planeMatrix, d1x, d1y, d2x, d2y])

  const onTextElement = useCallback((element: HTMLDivElement | null) => {
    textElRef.current = element
    // A replaced element has never had this rotation written to it, even when
    // the angle itself is unchanged.
    lastAngle.current = NaN
    // The label lands a commit after the frame that created it. With the
    // viewport's on-demand loop there may be no further frame to measure it
    // in, so ask for one.
    if (element && typeof invalidate === 'function') invalidate()
  }, [invalidate])

  // Per-frame writes are skipped while their inputs are unchanged. The geometry
  // memo below is what makes that safe: drei rebuilds a Line's geometry only
  // when `points` changes identity, so a selection or hover re-render does not
  // reset the halves to their initial full line under this cache.
  const measured = useRef({ label: '', width: 0, height: 0 })
  const written = useRef({ width: -1, height: -1, alongWpp: -1, isoWpp: -1, labelX: NaN, labelY: NaN, d1x: NaN, d1y: NaN, d2x: NaN, d2y: NaN })

  const halfPoints = useMemo(() => [
    [[d1x, d1y, 0], [d2x, d2y, 0]] as [number, number, number][],
    [[d1x, d1y, 0], [d2x, d2y, 0]] as [number, number, number][],
  ], [d1x, d1y, d2x, d2y])
  const leaderPoints = useMemo<[number, number, number][]>(() => {
    const from: [number, number, number] = tLabel < 0 ? [d1x, d1y, 0] : [d2x, d2y, 0]
    return [from, [labelX, labelY, 0]]
  }, [d1x, d1y, d2x, d2y, labelX, labelY, tLabel])

  useFrame(() => {
    const text = textElRef.current
    const deg = linearLabelAngleDeg(camera, viewportWidth, viewportHeight, planeMatrix, d1x, d1y, d2x, d2y)
    if (text && deg !== null) {
      const rounded = roundTenth(deg)
      if (rounded !== lastAngle.current) {
        text.style.transform = `rotate(${rounded}deg)`
        lastAngle.current = rounded
      }
    }

    // A changed value re-measures; a fresh element has not been laid out yet,
    // so keep asking until it has a width instead of caching a zero.
    if (text && (measured.current.label !== label || measured.current.width <= 0)) {
      measured.current = { label, width: text.offsetWidth, height: text.offsetHeight }
    }
    const textWidth = measured.current.width
    const textHeight = measured.current.height
    // The text width is a screen length; measured along the dimension line it
    // covers `textWidth * alongWpp` world, which is what the cut has to span.
    // The isotropic scale would undershoot on a foreshortened line and make
    // the cut vanish edge-on.
    const alongWpp = linearLabelAlongWorldPerPixel(camera, viewportWidth, viewportHeight, planeMatrix, d1x, d1y, d2x, d2y)
    if (textWidth <= 0 || alongWpp <= 0) return
    // The on-line tolerance is a perpendicular distance, so it keeps the
    // isotropic pixel scale.
    const isoWpp = linearLabelWorldPerPixel(camera, viewportHeight, planeMatrix, labelX, labelY)

    const w = written.current
    if (
      textWidth === w.width && textHeight === w.height
      && alongWpp === w.alongWpp && isoWpp === w.isoWpp
      && labelX === w.labelX && labelY === w.labelY
      && d1x === w.d1x && d1y === w.d1y && d2x === w.d2x && d2y === w.d2y
    ) return
    written.current = { width: textWidth, height: textHeight, alongWpp, isoWpp, labelX, labelY, d1x, d1y, d2x, d2y }

    const gapWorld = (textWidth + 2 * LABEL_GAP_PADDING_PX) * alongWpp
    const segs = dimensionLineGap(
      [d1x, d1y], [d2x, d2y], [labelX, labelY], gapWorld, (textHeight / 2) * isoWpp,
    )
    const [segA, segB] = segs
    if (segA) showLineSpan(halfARef.current, segA[0][0], segA[0][1], segA[1][0], segA[1][1])
    else hideLine(halfARef.current)
    if (segB) showLineSpan(halfBRef.current, segB[0][0], segB[0][1], segB[1][0], segB[1][1])
    else hideLine(halfBRef.current)

    // An outside label keeps its leader, but the leader stops at the near edge
    // of the glyph block rather than running into the digits. The text width is
    // the along-leader extent when the label sits past the end of the line,
    // which is where a leader normally points, so it uses the same along-line
    // scale as the gap.
    if (!isInside) {
      const startX = tLabel < 0 ? d1x : d2x
      const startY = tLabel < 0 ? d1y : d2y
      const dx = labelX - startX, dy = labelY - startY
      const dist = Math.hypot(dx, dy)
      const reach = Math.max(0, dist - (textWidth / 2) * alongWpp)
      if (reach > 0 && dist > 0) {
        const k = reach / dist
        showLineSpan(leaderRef.current, startX, startY, startX + dx * k, startY + dy * k)
      } else {
        hideLine(leaderRef.current)
      }
    }
  })

  const onPointerDown = useDimLabelPointerDown(cid, interaction, resetDragMoved, anchorX, anchorY, labelX, labelY)
  useDimLabelRegistration({ cid, interaction, isDragged, labelX, labelY, planeTransform, onClick, onOver, onOut, onDoubleClick, onPointerDown })

  return (
    <group key={cid}>
      {!ext1.skip && <ExtensionLine start={[ext1.touchX, ext1.touchY]} end={[d1x, d1y]} color={color} />}
      {!ext2.skip && <ExtensionLine start={[ext2.touchX, ext2.touchY]} end={[d2x, d2y]} color={color} />}
      {/* Two halves, cut around the value each frame. Until that frame both
          carry the whole line, so nothing is ever a zero-length segment. */}
      {hasLine && (
        <>
          <Line ref={halfARef} points={halfPoints[0]} color={color} lineWidth={1} {...dimensionRenderLayer()} />
          <Line ref={halfBRef} points={halfPoints[1]} color={color} lineWidth={1} {...dimensionRenderLayer()} />
        </>
      )}
      {isInside ? (
        // Inside: arrows at boundaries pointing outward.
        // |<---X--->|
        <>
          <Arrowhead tip={[d1x, d1y]} from={[d2x, d2y]} color={color} />
          <Arrowhead tip={[d2x, d2y]} from={[d1x, d1y]} color={color} />
        </>
      ) : tLabel < 0 ? (
        // Outside near d1: both arrows point inward (into the dimension line), leader from d1 to label.
        // X--->|----|<-
        <>
          <Arrowhead tip={[d1x, d1y]} from={[d1x - udirX, d1y - udirY]} color={color} />
          <ArrowTail origin={[d1x, d1y]} dir={[-udirX, -udirY]} color={color} />
          <Arrowhead tip={[d2x, d2y]} from={[d2x + udirX, d2y + udirY]} color={color} />
          <ArrowTail origin={[d2x, d2y]} dir={[udirX, udirY]} color={color} />
          {hasLine && <Line ref={leaderRef} points={leaderPoints} color={color} lineWidth={1} {...dimensionRenderLayer()} />}
        </>
      ) : (
        // Outside near d2: both arrows point inward (into the dimension line), leader from d2 to label.
        // Same arrow config as outside near d1, but different leader line.
        // |---->|<----X
        <>
          <Arrowhead tip={[d1x, d1y]} from={[d1x - udirX, d1y - udirY]} color={color} />
          <ArrowTail origin={[d1x, d1y]} dir={[-udirX, -udirY]} color={color} />
          <Arrowhead tip={[d2x, d2y]} from={[d2x + udirX, d2y + udirY]} color={color} />
          <ArrowTail origin={[d2x, d2y]} dir={[udirX, udirY]} color={color} />
          {hasLine && <Line ref={leaderRef} points={leaderPoints} color={color} lineWidth={1} {...dimensionRenderLayer()} />}
        </>
      )}
      <DimensionLabel
        cid={cid} enabled={!!interaction}
        x={labelX} y={labelY} label={label} color={color}
        title={title}
        hovered={hovered}
        isDragged={isDragged}
        angleDeg={angleDeg}
        onTextElement={onTextElement}
      />
    </group>
  )
}
