import featureSketchIcon from '@/assets/icons/feature-sketch.svg'
import featureExtrudeIcon from '@/assets/icons/feature-extrude.svg'
import featureRevolveIcon from '@/assets/icons/feature-revolve.svg'
import featureWrapIcon from '@/assets/icons/feature-wrap.svg'
import featureSweepIcon from '@/assets/icons/feature-sweep.svg'
import featureOriginIcon from '@/assets/icons/feature-origin.svg'
import featurePlaneIcon from '@/assets/icons/feature-plane.svg'
import featureFilletIcon from '@/assets/icons/feature-fillet.svg'
import featureChamferIcon from '@/assets/icons/feature-chamfer.svg'
import featureShellIcon from '@/assets/icons/feature-shell.svg'
import featureMoveFaceIcon from '@/assets/icons/feature-move-face.svg'
import featureDeleteFaceIcon from '@/assets/icons/feature-delete-face.svg'
import featureBooleanIcon from '@/assets/icons/feature-boolean.svg'
import featureLinearPatternIcon from '@/assets/icons/feature-linear-pattern.svg'
import featureCircularPatternIcon from '@/assets/icons/feature-circular-pattern.svg'
import featureCurvePatternIcon from '@/assets/icons/feature-curve-pattern.svg'
import featureInstancePatternIcon from '@/assets/icons/feature-instance-pattern.svg'
import featureDeleteBodyIcon from '@/assets/icons/feature-delete-body.svg'
import featureHoleIcon from '@/assets/icons/feature-hole.svg'
import featureTransformIcon from '@/assets/icons/feature-transform.svg'
import featureMirrorIcon from '@/assets/icons/feature-mirror.svg'
import featureSplitIcon from '@/assets/icons/feature-split.svg'
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
    case 'wrap':            return featureWrapIcon
    case 'sweep':           return featureSweepIcon
    case 'origin':          return featureOriginIcon
    case 'fillet':          return featureFilletIcon
    case 'chamfer':         return featureChamferIcon
    case 'shell':           return featureShellIcon
    case 'move_face':       return featureMoveFaceIcon
    case 'delete_face':     return featureDeleteFaceIcon
    case 'boolean':         return featureBooleanIcon
    case 'linear_pattern':  return featureLinearPatternIcon
    case 'circular_pattern': return featureCircularPatternIcon
    case 'curve_pattern':   return featureCurvePatternIcon
    case 'instance_pattern': return featureInstancePatternIcon
    case 'delete_body':     return featureDeleteBodyIcon
    case 'hole':            return featureHoleIcon
    case 'transform':       return featureTransformIcon
    case 'mirror':          return featureMirrorIcon
    case 'split':           return featureSplitIcon
    case 'variable':        return featureVariableIcon
    case 'helix':           return featureHelixIcon
    case 'import_step':     return featureImportIcon
    default:                return featurePlaneIcon
  }
}
