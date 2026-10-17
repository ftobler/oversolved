import featureSketchIcon from '@/assets/icons/feature-sketch.svg'
import featureExtrudeIcon from '@/assets/icons/feature-extrude.svg'
import featureRevolveIcon from '@/assets/icons/feature-revolve.svg'
import featureSweepIcon from '@/assets/icons/feature-sweep.svg'
import featureOriginIcon from '@/assets/icons/feature-origin.svg'
import featurePlaneIcon from '@/assets/icons/feature-plane.svg'
import featureFilletIcon from '@/assets/icons/feature-fillet.svg'
import featureChamferIcon from '@/assets/icons/feature-chamfer.svg'
import featureShellIcon from '@/assets/icons/feature-shell.svg'
import featureLoftIcon from '@/assets/icons/feature-loft.svg'
import featureDraftIcon from '@/assets/icons/feature-draft.svg'
import featureMoveFaceIcon from '@/assets/icons/feature-move-face.svg'
import featureDeleteFaceIcon from '@/assets/icons/feature-delete-face.svg'
import featureBooleanIcon from '@/assets/icons/feature-boolean.svg'
import featureArrayIcon from '@/assets/icons/feature-array.svg'
import featureCircularArrayIcon from '@/assets/icons/feature-circular-array.svg'
import featureDeleteBodyIcon from '@/assets/icons/feature-delete-body.svg'
import featureHoleIcon from '@/assets/icons/feature-hole.svg'
import featureTransformIcon from '@/assets/icons/feature-transform.svg'
import featureMirrorIcon from '@/assets/icons/feature-mirror.svg'
import featureVariableIcon from '@/assets/icons/feature-variable.svg'
import featureHelixIcon from '@/assets/icons/feature-helix.svg'
import featureImportIcon from '@/assets/icons/icon-upload.svg'

// Falls back to the plane icon for unknown kinds (covers the `plane` kind and
// any future kind not yet wired here).
export function getFeatureIcon(kind: string | undefined): string {
  const lowerKind = kind?.toLowerCase()
  switch (lowerKind) {
    case 'sketch':          return featureSketchIcon
    case 'extrude':         return featureExtrudeIcon
    case 'revolve':         return featureRevolveIcon
    case 'sweep':           return featureSweepIcon
    case 'origin':          return featureOriginIcon
    case 'fillet':          return featureFilletIcon
    case 'chamfer':         return featureChamferIcon
    case 'shell':           return featureShellIcon
    case 'loft':            return featureLoftIcon
    case 'draft':           return featureDraftIcon
    case 'move_face':       return featureMoveFaceIcon
    case 'delete_face':     return featureDeleteFaceIcon
    case 'boolean':         return featureBooleanIcon
    case 'array':           return featureArrayIcon
    case 'circular_array':  return featureCircularArrayIcon
    case 'delete_body':     return featureDeleteBodyIcon
    case 'hole':            return featureHoleIcon
    case 'transform':       return featureTransformIcon
    case 'mirror':          return featureMirrorIcon
    case 'variable':        return featureVariableIcon
    case 'helix':           return featureHelixIcon
    case 'import_step':     return featureImportIcon
    default:                return featurePlaneIcon
  }
}
