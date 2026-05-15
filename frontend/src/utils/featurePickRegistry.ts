import type { PartDoc } from '@/types/cad'
import { parseQuery } from '@/utils/query'
import {
  applyAddExtrudeProfile,
  applyAddRevolveProfile,
  applySetHoleSketch,
  applyAddFilletEdge,
  applyAddChamferEdge,
  applySetBooleanTarget,
  applyAddBooleanTool,
  applySetDeleteBodyTarget,
  applySetTransformField,
  applySetMirrorField,
  applySetArraySourceBody,
} from '@/utils/yamlMutations'

export interface PrimaryPickInfo {
  field: string
  hostKind?: string
}

export const PRIMARY_PICK_FIELD: Record<string, PrimaryPickInfo> = {
  add_extrude: { field: 'sketch', hostKind: 'extrude' },
  add_revolve: { field: 'sketch', hostKind: 'revolve' },
  add_fillet: { field: 'edges', hostKind: 'fillet' },
  add_chamfer: { field: 'edges', hostKind: 'chamfer' },
  add_boolean: { field: 'boolean_target', hostKind: 'boolean' },
  add_hole: { field: 'sketch', hostKind: 'hole' },
  add_delete_body: { field: 'body', hostKind: 'delete_body' },
  add_array: { field: 'body', hostKind: 'array' },
  add_mirror: { field: 'body', hostKind: 'mirror' },
  add_transform: { field: 'body', hostKind: 'transform' },
}

export function isCompatibleWithField(id: string, field: string, _hostKind?: string): boolean {
  if (field === 'sketch') {
    return id.startsWith('entity:') || id.startsWith('face:') ||
      (id.startsWith('@') && !id.startsWith('@body_') && !id.startsWith('@builtin_'))
  }
  if (field === 'edges') {
    return id.startsWith('face:') || id.startsWith('edge:') || id.includes(':edge') || id.startsWith('?') ||
      (id.startsWith('@') && id.includes('/'))
  }
  if (field === 'boolean_target' || field === 'boolean_tool' || field === 'body') {
    return id.startsWith('@body_') || id.startsWith('?') || id.startsWith('body:') ||
      (id.startsWith('@') && !id.startsWith('@builtin_'))
  }
  return false
}

function resolveBodyRef(id: string): string {
  let bodyRef = id
  if (id.startsWith('body:')) {
    bodyRef = '@' + id.slice(5)
  } else if (id.startsWith('?')) {
    const parsed = parseQuery(id)
    if (parsed.kind === 'ancestry' && parsed.ids.length > 0) {
      bodyRef = parsed.ids[parsed.ids.length - 1]
    }
  } else if (id.startsWith('@') && id.includes('/')) {
    bodyRef = '@' + id.slice(1).split('/')[0]
  }
  if (bodyRef.startsWith('@') && !bodyRef.startsWith('@body_')) {
    bodyRef = '@body_' + bodyRef.slice(1)
  }
  return bodyRef
}

export function applyCompatibleSelection(
  doc: PartDoc,
  featureId: string,
  field: string,
  hostKind: string | undefined,
  selectionId: string,
): void {
  if (field === 'sketch') {
    if (hostKind === 'hole') {
      applySetHoleSketch(doc, featureId, selectionId)
    } else if (hostKind === 'revolve') {
      applyAddRevolveProfile(doc, featureId, selectionId)
    } else {
      applyAddExtrudeProfile(doc, featureId, selectionId)
    }
  } else if (field === 'edges') {
    if (hostKind === 'chamfer') {
      applyAddChamferEdge(doc, featureId, selectionId)
    } else {
      applyAddFilletEdge(doc, featureId, selectionId)
    }
  } else if (field === 'boolean_target') {
    const bodyRef = resolveBodyRef(selectionId)
    applySetBooleanTarget(doc, featureId, bodyRef)
  } else if (field === 'boolean_tool') {
    const bodyRef = resolveBodyRef(selectionId)
    applyAddBooleanTool(doc, featureId, bodyRef)
  } else if (field === 'body') {
    const bodyRef = resolveBodyRef(selectionId)
    if (hostKind === 'transform') {
      applySetTransformField(doc, featureId, 'body', bodyRef)
    } else if (hostKind === 'mirror') {
      applySetMirrorField(doc, featureId, 'body', bodyRef)
    } else if (hostKind === 'array') {
      applySetArraySourceBody(doc, featureId, bodyRef)
    } else {
      applySetDeleteBodyTarget(doc, featureId, bodyRef)
    }
  }
}
