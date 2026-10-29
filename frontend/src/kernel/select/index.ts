// The topology-select engine barrel: the structured selector language, its
// structural validator and the predicate evaluator over a solved body set. Pure
// TS, no OCC import; the MCP `select` tool (drive/mcpServer.ts) and the headless
// op (drive/headlessOps.ts) are the only consumers.

export { selectByPredicate, type EvalContext } from './select'
export { typeVocabulary } from './geometry'
export { selector as validateSelector, PREDICATE_KEYS } from './validate'
export { SelectorError } from './errors'
export type {
  CenterTest,
  EdgeGeometry,
  FaceGeometry,
  Predicate,
  RadiusTest,
  SelectItem,
  SelectKind,
  SelectResult,
  Selector,
  Vec3,
} from './types'
