import type { MateKind } from '@/types/cad'
import mateFixedIcon from '@/assets/icons/mate-fixed.svg'
import mateSlidingIcon from '@/assets/icons/mate-sliding.svg'
import mateRotatingIcon from '@/assets/icons/mate-rotating.svg'
import mateSlidingRotatingIcon from '@/assets/icons/mate-sliding-rotating.svg'
import mateSphericalIcon from '@/assets/icons/mate-spherical.svg'
import mateParallelIcon from '@/assets/icons/mate-parallel.svg'
import mateParallelPlaneDistanceIcon from '@/assets/icons/mate-parallel-plane-distance.svg'
import mateTangentialIcon from '@/assets/icons/mate-tangential.svg'
import mateCopyRotationIcon from '@/assets/icons/mate-copy-rotation.svg'

// One icon per mate kind, shared by the toolbar's insert buttons and the
// assembly editor's right edit card, so a kind cannot wear two glyphs depending
// on where it is drawn.
export const MATE_KIND_ICONS: Record<MateKind, string> = {
  fixed: mateFixedIcon,
  sliding: mateSlidingIcon,
  rotating: mateRotatingIcon,
  sliding_rotating: mateSlidingRotatingIcon,
  spherical: mateSphericalIcon,
  parallel: mateParallelIcon,
  parallel_plane_distance: mateParallelPlaneDistanceIcon,
  tangential: mateTangentialIcon,
  copy_rotation: mateCopyRotationIcon,
}
