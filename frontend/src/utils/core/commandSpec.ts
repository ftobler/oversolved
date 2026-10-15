// Command specs: the typed shape behind every named user action. A spec carries
// its metadata, a runtime-checked params schema, an enabled predicate and a
// body that returns a Result with the ids it created. Parsing is hand-rolled on
// purpose: payloads are a handful of fields, so a schema dependency would be
// more surface than it saves. The registry holds the specs of one editor and
// runs them against that editor's live context, so a programmatic call never
// reaches a dialog: a command that needs values takes them as data and the
// dialog becomes a front end that parses its input and calls execute.

import { okResult, type Result } from '@/session/result'
import type { CommandName } from '@/utils/core/commandNames'

// The registry's own failures, distinct from the session's: an unknown id or a
// payload that does not match the spec's params never reaches a run body. A
// context that cannot carry out a known command (delete_selected headlessly)
// returns `unsupported` rather than reporting an ok it did not perform.
export type CommandErrorCode = 'unknown-command' | 'invalid-params' | 'unsupported'

export interface CommandFailure {
  ok: false
  code: CommandErrorCode
  message: string
}

// A spec body returns the session Result (ok plus created ids, or a session
// failure); the registry widens it with its own failures so execute always has
// a Result to hand back.
export type CommandResult = Result | CommandFailure

// One field's parse outcome. Kept a discriminated union rather than a value or
// an error string so a string-valued field can never be read as an error.
export type ParseOutcome<T> = { ok: true; value: T } | { ok: false; error: string }

export interface FieldSpec<T = unknown> {
  // Human-readable type for error text and the docs table.
  type: string
  parse: (raw: unknown) => ParseOutcome<T>
}

export interface ParamFieldInfo {
  name: string
  type: string
}

// The runtime schema for a command's payload. `parse` receives the raw call
// argument (undefined for a no-params command) and returns the typed params.
export interface ParamsSpec<P> {
  fields: readonly ParamFieldInfo[]
  parse: (raw: unknown) => ParseOutcome<P>
}

export type ShapeValues<S extends Record<string, FieldSpec<unknown>>> = {
  [K in keyof S]: S[K] extends FieldSpec<infer T> ? T : never
}

function stringField(): FieldSpec<string> {
  return {
    type: 'string',
    parse: raw => typeof raw === 'string'
      ? { ok: true, value: raw }
      : { ok: false, error: 'expected a string' },
  }
}

function nullableStringField(): FieldSpec<string | null> {
  return {
    type: 'string | null',
    parse: raw => raw === null || typeof raw === 'string'
      ? { ok: true, value: raw as string | null }
      : { ok: false, error: 'expected a string or null' },
  }
}

function numberField(): FieldSpec<number> {
  return {
    type: 'number',
    parse: raw => typeof raw === 'number' && Number.isFinite(raw)
      ? { ok: true, value: raw }
      : { ok: false, error: 'expected a finite number' },
  }
}

function booleanField(): FieldSpec<boolean> {
  return {
    type: 'boolean',
    parse: raw => typeof raw === 'boolean'
      ? { ok: true, value: raw }
      : { ok: false, error: 'expected a boolean' },
  }
}

function anyField(): FieldSpec<unknown> {
  return { type: 'any', parse: raw => ({ ok: true, value: raw }) }
}

function objectField<S extends Record<string, FieldSpec<unknown>>>(shape: S): FieldSpec<ShapeValues<S>> {
  const spec = objectParams(shape)
  return { type: 'object', parse: spec.parse }
}

// The field constructors specs read from. One per JSON-shaped kind the command
// payloads actually carry.
export const Field = {
  string: stringField,
  nullableString: nullableStringField,
  number: numberField,
  boolean: booleanField,
  any: anyField,
  object: objectField,
}

// A command that takes no payload. It accepts and ignores whatever raw value a
// legacy call site passes, matching the old handlers' tolerance for undefined.
export function noParams(): ParamsSpec<null> {
  return { fields: [], parse: () => ({ ok: true, value: null }) }
}

// A command whose payload is the whole value (the tree rows pass a bare handle
// or feature id). The docs table shows the value's type under the field name.
export function valueParam<T>(field: FieldSpec<T>): ParamsSpec<T> {
  return { fields: [{ name: 'value', type: field.type }], parse: field.parse }
}

// An object payload parsed field by field. Missing and mistyped fields are
// rejected with a named message, so a caller learns which field was wrong.
export function objectParams<S extends Record<string, FieldSpec<unknown>>>(shape: S): ParamsSpec<ShapeValues<S>> {
  const entries = Object.entries(shape)
  return {
    fields: entries.map(([name, field]) => ({ name, type: field.type })),
    parse: raw => {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return { ok: false, error: 'expected an object payload' }
      }
      const record = raw as Record<string, unknown>
      const value: Record<string, unknown> = {}
      for (const [name, field] of entries) {
        const parsed = field.parse(record[name])
        if (!parsed.ok) return { ok: false, error: `field "${name}": ${parsed.error}` }
        value[name] = parsed.value
      }
      return { ok: true, value: value as ShapeValues<S> }
    },
  }
}

// The base every editor's context extends. `editor` keeps a spec list readable:
// a part spec cannot be run against an assembly context by accident.
export interface CommandContext {
  editor: 'part' | 'assembly'
}

// The context-free view of a registry: what module-level dispatch and the
// toolbar context need. The class satisfies it for every context type, which is
// what lets a CommandRegistry<PartCommandContext> be handed around as a plain
// command table without leaking its context parameter.
export interface CommandTableView {
  has(id: CommandName): boolean
  enabled(id: CommandName): true | string
  execute(id: CommandName, rawParams?: unknown): CommandResult
}

export interface CommandSpec<Ctx extends CommandContext = CommandContext, P = unknown> {
  id: CommandName
  label: string
  // Canonical key string from the owning editor's keymap, when one exists.
  shortcut?: string
  params: ParamsSpec<P>
  // True when the action can run; a string is the reason it cannot, which the
  // UI shows as the disabled state.
  enabled: (ctx: Ctx) => true | string
  run: (ctx: Ctx, params: P) => CommandResult
  // Whether run may push an undo entry. Metadata for docs and future surfaces;
  // the doc path itself still decides per mutation.
  undoable: boolean
}

// One editor's command table. The registry is an instance, not a module-level
// map, so two co-mounted editors cannot overwrite each other's shared names
// (undo, redo, delete_selected): each instance only ever holds its own specs,
// and dispatch picks the instance the active editor installed.
// The stored form erases the params type: the registry parses through the
// spec's own schema, so it never needs the compile-time payload type, and the
// wrapper keeps the cast in one place. Also the element type of a heterogeneous
// spec list (an editor's command table mixes no-params, value and object
// payloads, which no single CommandSpec<P> can hold).
export interface ErasedCommandSpec<Ctx extends CommandContext = CommandContext> {
  id: CommandName
  label: string
  shortcut?: string
  params: ParamsSpec<unknown>
  enabled: (ctx: Ctx) => true | string
  run: (ctx: Ctx, params: never) => CommandResult
  undoable: boolean
}

export class CommandRegistry<Ctx extends CommandContext = CommandContext> {
  private readonly specs = new Map<CommandName, ErasedCommandSpec<Ctx>>()
  private readonly contextSource: () => Ctx

  constructor(contextSource?: () => Ctx) {
    this.contextSource = contextSource ?? (() => ({ editor: 'part' } as Ctx))
  }

  // Returns an unregister bound to this exact spec. It removes the entry only
  // while the map still holds it, so a stale owner (an older mount whose name a
  // newer one has since overwritten) cannot remove the newer spec. The
  // parameter is the erased form, so a fully typed CommandSpec<Ctx, P> is
  // accepted without a cast (its run is assignable to the never-param form).
  register(spec: ErasedCommandSpec<Ctx>): () => void {
    if (import.meta.env.DEV && this.specs.has(spec.id)) {
      console.warn(`CommandRegistry: overwriting existing spec for "${spec.id}"`)
    }
    this.specs.set(spec.id, spec)
    return () => {
      if (this.specs.get(spec.id) === spec) this.specs.delete(spec.id)
    }
  }

  clear(): void {
    this.specs.clear()
  }

  has(id: CommandName): boolean {
    return this.specs.has(id)
  }

  ids(): CommandName[] {
    return [...this.specs.keys()]
  }

  // The enabled verdict for the live context. An unknown id is a reason too:
  // callers disable on anything that is not `true`, so a missing spec can never
  // read as runnable.
  enabled(id: CommandName): true | string {
    const spec = this.specs.get(id)
    if (!spec) return `unknown command "${id}"`
    return spec.enabled(this.contextSource())
  }

  // Runs a registered spec. Unknown ids and payloads that fail the spec's
  // params never reach a run body; both come back as error Results instead of
  // throwing, so a headless caller can observe them.
  execute(id: CommandName, rawParams?: unknown): CommandResult {
    const spec = this.specs.get(id)
    if (!spec) {
      return { ok: false, code: 'unknown-command', message: `unknown command "${id}"` }
    }
    const parsed = spec.params.parse(rawParams)
    if (!parsed.ok) {
      return { ok: false, code: 'invalid-params', message: `invalid params for "${id}": ${parsed.error}` }
    }
    // The stored form erased the payload type; the schema above is the
    // authority for what the value actually is.
    return spec.run(this.contextSource(), parsed.value as never)
  }

  // The compatibility spec behind registerCommand: a bare callback with no
  // metadata, enabled always, no created ids.
  static legacySpec<Ctx extends CommandContext>(id: CommandName, fn: (payload?: unknown) => void): CommandSpec<Ctx, unknown> {
    return {
      id,
      label: id,
      params: { fields: [], parse: raw => ({ ok: true, value: raw }) },
      enabled: () => true,
      run: (_ctx, payload) => {
        fn(payload)
        return okResult()
      },
      undoable: false,
    }
  }
}
