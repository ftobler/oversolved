import { describe, it, expect } from 'vitest'
import { queryLabel, extractFeatureId } from '@/utils/query/queryLabel'
import type { PartFeature } from '@/types/cad'

const features: PartFeature[] = [
  { id: 'extrude1', kind: 'extrude', label: 'My Extrude' },
  { id: 'ex1', kind: 'extrude', label: 'My Extrude' },
  { id: 'ab-1', kind: 'extrude', label: 'Dash Feature' },
  { id: 'e1tMr2u-m4rxTxhoZSw2z05E', kind: 'extrude', label: 'Real Base64url' },
  { id: 'sk1', kind: 'sketch', label: 'Sketch 1' },
  { id: 'fillet2', kind: 'fillet', label: 'Fillet 2' },
  { id: 'sketch3', kind: 'sketch' },
]

describe('queryLabel', () => {
  describe('builtin planes', () => {
    it('returns Front for @builtin_plane_front', () => {
      expect(queryLabel('@builtin_plane_front', features)).toBe('Front')
    })

    it('returns Top for @builtin_plane_top', () => {
      expect(queryLabel('@builtin_plane_top', features)).toBe('Top')
    })

    it('returns Right for @builtin_plane_right', () => {
      expect(queryLabel('@builtin_plane_right', features)).toBe('Right')
    })

    it('returns Origin for @builtin_origin', () => {
      // The origin reaches chips through the plane editors' point fields, where
      // it would otherwise fall through to the raw id.
      expect(queryLabel('@builtin_origin', features)).toBe('Origin')
    })
  })

  describe('ancestry queries', () => {
    it('returns Face of <feature label> for ancestry face query', () => {
      // @extrude1face0 = 14 chars → hex "e"
      const q = '?e,e;@extrude1face0@extrude1face1:flatface'
      expect(queryLabel(q, features)).toBe('Face of My Extrude')
    })

    it('returns Edge of <feature label> for ancestry edge query', () => {
      // @fillet2edge0 = 13 chars → hex "d"
      const q = '?d,d;@fillet2edge0@fillet2edge1:straightedge'
      expect(queryLabel(q, features)).toBe('Edge of Fillet 2')
    })

    it('returns Vertex of <feature label> for ancestry vertex query', () => {
      // @sk1vertex0 = 11 chars → hex "b"
      const q = '?b;@sk1vertex0:vertex'
      expect(queryLabel(q, features)).toBe('Vertex of Sketch 1')
    })

    it('uses feature ID when feature has no label', () => {
      // @sketch3face0 = 13 chars → hex "d"
      const q = '?d;@sketch3face0:flatface'
      expect(queryLabel(q, features)).toBe('Face of sketch3')
    })

    it('returns raw query when feature ID cannot be extracted', () => {
      const q = '?2;?!:flatface'
      expect(queryLabel(q, features)).toBe(q)
    })

    it('returns Face for a cylinderface restriction', () => {
      // @extrude1face0 = 14 chars → hex "e"
      const q = '?e;@extrude1face0:cylinderface'
      expect(queryLabel(q, features)).toBe('Face of My Extrude')
    })

    it('returns Face for a coneface restriction', () => {
      // @extrude1face0 = 14 chars → hex "e"
      const q = '?e;@extrude1face0:coneface'
      expect(queryLabel(q, features)).toBe('Face of My Extrude')
    })

    it('returns Face for a sphereface restriction', () => {
      const q = '?e;@extrude1face0:sphereface'
      expect(queryLabel(q, features)).toBe('Face of My Extrude')
    })

    it('returns Face for a torusface restriction', () => {
      const q = '?e;@extrude1face0:torusface'
      expect(queryLabel(q, features)).toBe('Face of My Extrude')
    })

    it('returns Edge for a bare "edge" restriction', () => {
      // @fillet2edge0 = 13 chars → hex "d"
      const q = '?d;@fillet2edge0:edge'
      expect(queryLabel(q, features)).toBe('Edge of Fillet 2')
    })

    it('falls back to "Entity" for an unrecognized type restriction', () => {
      // @extrude1face0 = 14 chars → hex "e"; ":wibble" is not a known type.
      const q = '?e;@extrude1face0:wibble'
      expect(queryLabel(q, features)).toBe('Entity of My Extrude')
    })

    it('falls back to "Entity" when no type restriction is present', () => {
      // @extrude1face0 = 14 chars → hex "e"; no ":type" suffix at all.
      const q = '?e;@extrude1face0'
      expect(queryLabel(q, features)).toBe('Entity of My Extrude')
    })

    it('uses the bare feature ID when the ancestry feature is not in the list', () => {
      // @ghost1face0 = 12 chars → hex "c"; "ghost1" is not a known feature.
      const q = '?c;@ghost1face0:flatface'
      expect(queryLabel(q, features)).toBe('Face of ghost1')
    })

    it('resolves the owning feature for a slash-joined body face token', () => {
      // @body_ex1/face0 = 15 chars → hex "f"; the body tag names feature "ex1".
      const q = '?f;@body_ex1/face0:flatface'
      expect(queryLabel(q, features)).toBe('Face of My Extrude')
    })

    it('resolves the owning feature for a slash-joined feature face token', () => {
      // @extrude1/face/3 = 16 chars → hex "10"; the entity index trails the slash.
      const q = '?10;@extrude1/face/3:flatface'
      expect(queryLabel(q, features)).toBe('Face of My Extrude')
    })

    it('resolves the owning feature for a slash-joined feature edge token', () => {
      // @extrude1/edge/1 = 16 chars → hex "10".
      const q = '?10;@extrude1/edge/1:straightedge'
      expect(queryLabel(q, features)).toBe('Edge of My Extrude')
    })

    it('resolves the owning feature for a bare body tag', () => {
      // @body_ex1 = 9 chars → hex "9"; the bare body tag must name feature
      // "ex1", not read "body_ex1" as the feature id.
      const q = '?9;@body_ex1:flatface'
      expect(queryLabel(q, features)).toBe('Face of My Extrude')
    })

    it('resolves the feature for a bare feature tag', () => {
      // @extrude1 = 9 chars → hex "9".
      const q = '?9;@extrude1:flatface'
      expect(queryLabel(q, features)).toBe('Face of My Extrude')
    })

    it('uses the bare feature ID when the body feature is not in the list', () => {
      // @body_nope/face0 = 16 chars → hex "10"; "nope" is not a known feature.
      const q = '?10;@body_nope/face0:flatface'
      expect(queryLabel(q, features)).toBe('Face of nope')
    })

    it('resolves a dash-containing base64url feature id in a body face token', () => {
      // Feature ids are randomId(18) base64url, which mints "-" and "_"
      // (helpers.ts randomId): "ab-1" would fail a \w-only regex. @body_ab-1/face0
      // = 16 chars → hex "10".
      const q = '?10;@body_ab-1/face0:flatface'
      expect(queryLabel(q, features)).toBe('Face of Dash Feature')
    })

    it('resolves a dash-containing base64url feature id in a bare feature tag', () => {
      // @e1tMr2u-m4rxTxhoZSw2z05E = 25 chars → hex "19"; no entity suffix.
      const q = '?19;@e1tMr2u-m4rxTxhoZSw2z05E:flatface'
      expect(queryLabel(q, features)).toBe('Face of Real Base64url')
    })

    it('strips the derived-body numbered suffix to find the owning feature', () => {
      // Array/mirror siblings mint body_<feat>_N (see the pickIdentity corpus:
      // @body_e1tMr2u-..._1/_2/_3). The owning feature is the id minus the
      // trailing numbered suffix. @body_e1tMr2u-m4rxTxhoZSw2z05E_1/face0
      // = 38 chars → hex "26".
      const q = '?26;@body_e1tMr2u-m4rxTxhoZSw2z05E_1/face0:flatface'
      expect(queryLabel(q, features)).toBe('Face of Real Base64url')
    })

    it('falls through to the raw query when the last ancestor is a construction UUID', () => {
      // @u|u_abc = 8 chars → hex "8".
      const q = '?8;@u|u_abc:flatface'
      expect(queryLabel(q, features)).toBe(q)
    })

    it('falls through to the raw query when the last ancestor is a classifier', () => {
      // @cls_zp = 7 chars → hex "7".
      const q = '?7;@cls_zp:flatface'
      expect(queryLabel(q, features)).toBe(q)
    })

    it('falls through to the raw query when the last ancestor is a descriptor', () => {
      // @gde|line|x = 11 chars → hex "b".
      const q = '?b;@gde|line|x:flatface'
      expect(queryLabel(q, features)).toBe(q)
    })

    it('resolves an earlier ancestor id when the last ancestor is a special token', () => {
      // The trailing @cls_zp (7 chars) is a classifier token and extractFeatureId
      // returns null for it, but the backward scan keeps looking and finds the
      // resolvable @extrude1 (9 chars) earlier in the chain.
      const q = '?9,7;@extrude1@cls_zp:flatface'
      expect(queryLabel(q, features)).toBe('Face of My Extrude')
    })

    it('falls through to the raw query when every ancestor id is a special token', () => {
      // Both ids are unresolvable special tokens: the backward scan exhausts
      // the chain and the raw query string is the only thing left to show.
      // @cls_zp (7 chars), @u|u_abc (8 chars).
      const q = '?7,8;@cls_zp@u|u_abc:flatface'
      expect(queryLabel(q, features)).toBe(q)
    })
  })

  describe('absolute queries', () => {
    it('returns feature label for feature reference', () => {
      expect(queryLabel('@extrude1', features)).toBe('My Extrude')
    })

    it('returns feature ID when feature has no label', () => {
      expect(queryLabel('@sketch3', features)).toBe('sketch3')
    })

    it('returns feature ID for unknown feature', () => {
      expect(queryLabel('@nonexistent', features)).toBe('nonexistent')
    })
  })

  describe('topo-fallback queries', () => {
    it('names a topo-fallback face as Face of the owning feature', () => {
      expect(queryLabel('@body_ex1/face/3', features)).toBe('Face of My Extrude')
    })

    it('names a topo-fallback edge as Edge of the owning feature', () => {
      expect(queryLabel('@body_ex1/edge/1', features)).toBe('Edge of My Extrude')
    })

    it('names a topo-fallback vertex as Vertex of the owning feature', () => {
      expect(queryLabel('@body_ex1/vertex/2', features)).toBe('Vertex of My Extrude')
    })

    it('resolves a split-sibling body tag to its owning feature', () => {
      expect(queryLabel('@body_ex1_1/face/0', features)).toBe('Face of My Extrude')
    })

    it('prefers a feature literally named ex1_1 over the body-suffix strip', () => {
      // The label resolver shares pickOrder's known-set longest-prefix
      // resolution: when a feature really is named `ex1_1`, the sibling suffix
      // belongs to it, not to `ex1`. extractFeatureId (no known set) still
      // strips, but queryLabel must not.
      const withSibling = [...features, { id: 'ex1_1', kind: 'extrude', label: 'Ex1 One' }]
      expect(queryLabel('@body_ex1_1/face/0', withSibling)).toBe('Face of Ex1 One')
    })

    it('falls back to the body id when the owning feature is unknown', () => {
      expect(queryLabel('@body_ghost1/face/0', features)).toBe('Face of ghost1')
    })

    it('leaves the whole-body ref rendering as a part, not a primitive pick', () => {
      // No slash, so parseTopoFallbackQuery rejects it and the absolute-query
      // branch (with partLabels) still names the whole body.
      const partLabels = { body_ex1: 'Part 3' }
      expect(queryLabel('@body_ex1', features, partLabels)).toBe('Part 3')
    })
  })

  describe('body references via partLabels', () => {
    it('returns part label from partLabels map keyed by bare body ID', () => {
      const partLabels = { body_ex1: 'Part 3' }
      expect(queryLabel('@body_ex1', features, partLabels)).toBe('Part 3')
    })

    it('falls back to the full-query key when the bare body ID is absent', () => {
      // Only the full query string is present in the map, not the parsed featureId.
      const partLabels = { '@body_ex1': 'Part Q' }
      expect(queryLabel('@body_ex1', features, partLabels)).toBe('Part Q')
    })
  })

  describe('local queries', () => {
    it('returns entity ID for local query', () => {
      expect(queryLabel('$line1', features)).toBe('line1')
    })

    it('returns entity ID with sub-element', () => {
      expect(queryLabel('$line1start', features)).toBe('line1')
    })
  })

  describe('sketch picks', () => {
    // Stored verbatim as the selection id the viewport toggled (extrude and
    // sweep take them as profile/path refs), so they never reach parseQuery.
    it('names the sketch an entity pick came from', () => {
      expect(queryLabel('entity:sk1:c1', features)).toBe('Entity of Sketch 1')
    })

    it('names a vertex pick as a vertex', () => {
      expect(queryLabel('vertex:sk1:c1:center', features)).toBe('Vertex of Sketch 1')
    })

    it('falls back to the bare sketch id for an unknown feature', () => {
      expect(queryLabel('entity:ghost1:c1', features)).toBe('Entity of ghost1')
    })

    it('leaves a prefix with no entity id alone', () => {
      expect(queryLabel('entity:sk1', features)).toBe('entity:sk1')
      expect(queryLabel('entity:sk1:', features)).toBe('entity:sk1:')
    })
  })

  describe('edge cases', () => {
    it('returns None for empty string', () => {
      expect(queryLabel('', features)).toBe('None')
    })

    it('returns None for "None" string', () => {
      expect(queryLabel('None', features)).toBe('None')
    })

    it('returns raw query for unrecognized query format', () => {
      expect(queryLabel('!invalid', features)).toBe('!invalid')
    })

    it('returns raw query for plain text', () => {
      expect(queryLabel('just some text', features)).toBe('just some text')
    })
  })
})

describe('extractFeatureId', () => {
  describe('slash-joined token shapes (current wire format)', () => {
    it('extracts the owning feature from a slash-joined body face token', () => {
      expect(extractFeatureId('@body_ex1/face0')).toBe('ex1')
    })

    it('extracts the feature from a face-with-index token', () => {
      expect(extractFeatureId('@extrude1/face/3')).toBe('extrude1')
    })

    it('extracts the feature from an edge token', () => {
      expect(extractFeatureId('@extrude1/edge/1')).toBe('extrude1')
    })

    it('extracts the feature from a vertex token', () => {
      expect(extractFeatureId('@sk1/vertex/2')).toBe('sk1')
    })

    it('extracts the owning feature from a bare body tag', () => {
      expect(extractFeatureId('@body_ex1')).toBe('ex1')
    })

    it('extracts the feature from a bare feature tag', () => {
      expect(extractFeatureId('@extrude1')).toBe('extrude1')
    })
  })

  describe('base64url feature ids (randomId(18) mints "-" and "_")', () => {
    it('extracts a dash-containing base64url id from a slash-joined body token', () => {
      expect(extractFeatureId('@body_ab-1/face0')).toBe('ab-1')
    })

    it('extracts a base64url id with both dashes and underscores', () => {
      expect(extractFeatureId('@body_e1tMr2u-m4rxTxhoZSw2z05E/face0')).toBe('e1tMr2u-m4rxTxhoZSw2z05E')
    })

    it('strips the derived-body numbered suffix to find the owning feature', () => {
      expect(extractFeatureId('@body_e1tMr2u-m4rxTxhoZSw2z05E_1/face0')).toBe('e1tMr2u-m4rxTxhoZSw2z05E')
    })
  })

  describe('special tokens that fall through to the raw query', () => {
    it('falls through for a construction UUID token', () => {
      expect(extractFeatureId('@u|u_abc')).toBeNull()
    })

    it('falls through for a classifier token', () => {
      expect(extractFeatureId('@cls_zp')).toBeNull()
    })

    it('falls through for a face geom-hash reference', () => {
      expect(extractFeatureId('@gface_abc123')).toBeNull()
    })

    it('falls through for an edge geom-hash reference', () => {
      expect(extractFeatureId('@gedge_abc123')).toBeNull()
    })

    it('falls through for a vertex geom-hash reference', () => {
      expect(extractFeatureId('@gvertex_abc123')).toBeNull()
    })

    it('falls through for a normal geom-hash reference', () => {
      expect(extractFeatureId('@gnormal_abc123')).toBeNull()
    })

    it('falls through for a face descriptor', () => {
      expect(extractFeatureId('@gdf|0.000|0.000|0.000|0.000|0.000|1.000')).toBeNull()
    })

    it('falls through for an edge descriptor', () => {
      expect(extractFeatureId('@gde|line|0,0,0|1,0,0|2.0')).toBeNull()
    })

    it('falls through for a vertex descriptor', () => {
      expect(extractFeatureId('@gdv|0,0,0')).toBeNull()
    })
  })

  describe('unknown feature ids', () => {
    it('returns null when the token does not look like a feature ref', () => {
      expect(extractFeatureId('@')).toBeNull()
    })

    it('returns null for an empty body tag', () => {
      expect(extractFeatureId('@body_')).toBeNull()
    })

    it('returns null for a token with no @-feature shape', () => {
      expect(extractFeatureId('?e,e;@extrude1face0@extrude1face1')).toBeNull()
    })
  })
})
