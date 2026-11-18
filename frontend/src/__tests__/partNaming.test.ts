// The vocabulary guard: code and UI say part, only the register says body.
//
// Walks every source file and every declaration in it, and fails on a name
// whose word parts contain the stored vocabulary's word (the register's word)
// unless `partNamingRegister.ts` lists it with the stored key, wire field or
// third-party reason. The assembly section below adds Decision 0's rule: in a
// file where a part document and a user part meet, no identifier means both.
//
// The point is drift: a new helper named after the old vocabulary fails here
// before it reaches review, and the message says what to do instead.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { PART_NAMING_KEEP, type PartNamingKind } from '../partNamingRegister'

const SRC = fileURLToPath(new URL('..', import.meta.url))

/** Identifiers are word-part matched: `somebody` is not the word, `partOps` is. */
function wordParts(name: string): string[] {
  return name.split(/(?<=[a-z0-9])(?=[A-Z])|_|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])/)
}

const KEPT_WORD = /^bod(y|ies)$/i

function hasKeptWord(name: string): boolean {
  return wordParts(name).some(part => KEPT_WORD.test(part))
}

function globMatch(pattern: string, rel: string): boolean {
  const rx = pattern
    .split('**')
    .map(seg => seg.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*'))
    .join('.*')
  return new RegExp(`^${rx}$`).test(rel)
}

function isKept(name: string, kind: PartNamingKind, rel: string): boolean {
  return PART_NAMING_KEEP.some(entry =>
    entry.name === name &&
    (entry.kinds === undefined || entry.kinds.includes(kind)) &&
    (entry.files === undefined || entry.files.some(pattern => globMatch(pattern, rel))))
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

interface Offence {
  file: string
  line: number
  name: string
  kind: PartNamingKind
}

function declarationKind(node: ts.Node): PartNamingKind | null {
  if (ts.isVariableDeclaration(node)) return 'variable'
  if (ts.isFunctionDeclaration(node)) return 'function'
  if (ts.isClassDeclaration(node)) return 'class'
  if (ts.isInterfaceDeclaration(node)) return 'interface'
  if (ts.isTypeAliasDeclaration(node)) return 'type'
  if (ts.isEnumDeclaration(node)) return 'enum'
  if (ts.isEnumMember(node)) return 'enumMember'
  if (ts.isParameter(node)) return 'parameter'
  if (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) return 'property'
  if (ts.isMethodDeclaration(node)) return 'method'
  if (ts.isTypeParameterDeclaration(node)) return 'typeParameter'
  // A re-export alias is the module's public name: `export { partFrame as
  // bodyFrame }` keeps the old word at every importer, so it is checked too.
  if (ts.isExportSpecifier(node)) return 'variable'
  return null
}

function declaredName(node: ts.Node): ts.Identifier | undefined {
  const named = node as { name?: ts.Node }
  if (named.name && ts.isIdentifier(named.name)) return named.name
  return undefined
}

function checkFile(full: string, rel: string, offences: Offence[]): void {
  const text = fs.readFileSync(full, 'utf8')
  const scriptKind = full.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const source = ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true, scriptKind)
  const at = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  const record = (node: ts.Node, name: string, kind: PartNamingKind) => {
    if (hasKeptWord(name) && !isKept(name, kind, rel)) offences.push({ file: rel, line: at(node), name, kind })
  }

  const visit = (node: ts.Node) => {
    const kind = declarationKind(node)
    const name = kind ? declaredName(node) : undefined
    if (kind && name) record(name, name.text, kind)

    if (ts.isBindingElement(node)) {
      // A shorthand binding aliases the property symbol, so the language
      // service cannot rename its local half alone. When the property is a
      // register key the whole binding stays; otherwise the local name is
      // checked like any other declaration.
      const property = node.propertyName && ts.isIdentifier(node.propertyName) ? node.propertyName.text : name?.text
      const propertyKept = property !== undefined && isKept(property, 'property', rel)
      if (!propertyKept && name) record(name, name.text, 'binding')
    }

    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ts.isIdentifier(node.tagName)) {
      // Lowercase tags are intrinsics; a capitalised one is a component whose
      // import binding the declaration walk already checks.
      const tag = node.tagName.text
      if (tag[0] === tag[0].toUpperCase()) record(node, tag, 'variable')
    }

    ts.forEachChild(node, visit)
  }
  visit(source)
}

describe('part naming', () => {
  it('keeps the stored vocabulary only where the register says why', () => {
    const offences: Offence[] = []
    const files = walk(SRC)
    for (const full of files) {
      const rel = path.relative(SRC, full).split(path.sep).join('/')
      if (hasKeptWord(path.basename(full)) && !isKept(path.basename(full), 'file', rel)) {
        offences.push({ file: rel, line: 1, name: path.basename(full), kind: 'file' })
      }
      if (/\.(ts|tsx)$/.test(full) && !full.endsWith('.d.ts')) checkFile(full, rel, offences)
    }
    const report = offences
      .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
      .map(o => `  ${o.file}:${o.line} ${o.kind} "${o.name}"`)
      .join('\n')
    expect(offences, `\nname it part, or add it to the register with the stored key or DOM reason:\n${report}\n`).toEqual([])
  }, 120_000)

  it('never lets one identifier mean both the document and the user part', () => {
    // Decision 0: the part document keeps PartDoc/doc, the user part takes
    // part. These are the files where the two meet; a variable called `part`
    // there must never be a PartDoc.
    const overloaded = [
      'drive/headlessAssembly.ts',
      'drive/assemblyOut.ts',
      'drive/assemblyDetail.ts',
      'kernel/partBundle.ts',
      'components/layout/PartInstanceEditor.tsx',
    ]
    const problems: string[] = []
    for (const rel of overloaded) {
      const full = path.join(SRC, rel)
      if (!fs.existsSync(full)) continue
      const text = fs.readFileSync(full, 'utf8')
      const source = ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true, rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
      const meanings = new Map<string, Set<'doc' | 'part'>>()
      const note = (name: string, meaning: 'doc' | 'part') => {
        const set = meanings.get(name) ?? new Set()
        set.add(meaning)
        meanings.set(name, set)
      }
      const visit = (node: ts.Node) => {
        const kind = declarationKind(node)
        const name = kind ? declaredName(node) : undefined
        const annotation = (node as { type?: ts.TypeNode }).type
        if (kind && name && annotation) {
          const typeText = annotation.getText(source)
          // A function type's PartDoc parameter is the callback's own binding,
          // not this declaration's meaning.
          if (!typeText.includes('=>')) {
            if (/\bPartDoc\b/.test(typeText)) note(name.text, 'doc')
            if (/\b(PartResult|PartSolid|PartBundle)\b/.test(typeText)) note(name.text, 'part')
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
      for (const [name, set] of meanings) {
        if (set.size > 1) problems.push(`${rel}: "${name}" is both a part document and a user part`)
        if (set.has('doc') && /^(part|partId)$/.test(name)) {
          problems.push(`${rel}: "${name}" holds a PartDoc; call it doc or partDoc`)
        }
        if (set.has('part') && /^(doc|partDoc|docId|partDocId)$/.test(name)) {
          problems.push(`${rel}: "${name}" holds a user part; call it part or partId`)
        }
      }
    }
    expect(problems, `\n${problems.join('\n')}\n`).toEqual([])
  }, 60_000)
})
