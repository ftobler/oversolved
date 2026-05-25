import AppHeader from '@/components/AppHeader'
import { CONSTRAINTS, ENTITIES, DIMENSION_RULES, CONSTRAINT_BY_KIND, ENTITY_BY_ACTIVE_TOOL, CONSTRAINT_SHORTCUTS, ENTITY_SHORTCUTS, SNAP_RULES, SNAP_KINDS } from '@/registry'
import { KEYMAP, CORE_KEYBINDINGS } from '@/stores/commandRegistry'
import { SINGLE_ENTITY_RULES, MULTI_ENTITY_RULES } from '@/registry/measurementRegistry'
import '@/pages/Registry.css'

// Eager-load all icons so we can display them inline.
const iconModules = import.meta.glob('@/assets/icons/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

function iconUrl(filename: string | undefined): string | undefined {
  if (!filename) return undefined
  return iconModules[`/src/assets/icons/${filename}.svg`]
    ?? iconModules[`../assets/icons/${filename}.svg`]
}

function Icon({ file, size = 18 }: { file: string | undefined; size?: number }) {
  const url = iconUrl(file)
  if (!url) return <span className="reg-no-icon">—</span>
  return <img src={url} width={size} height={size} className="reg-icon" alt={file} />
}

function Badge({ text, variant }: { text: string; variant: 'geo' | 'dim' | 'yes' | 'no' | 'neutral' }) {
  return <span className={`reg-badge reg-badge--${variant}`}>{text}</span>
}

// ── Keybindings section ────

type KeybindingRow = { key: string; command: string; label: string; description: string }

function buildKeybindingRows(): KeybindingRow[] {
  const rows: KeybindingRow[] = []

  // Core bindings (with labels and descriptions from CORE_KEYBINDINGS)
  for (const b of CORE_KEYBINDINGS) {
    rows.push({ key: b.key, command: b.command, label: b.label, description: b.description })
  }

  // Constraint shortcuts — derive label/description from constraint registry
  for (const [key, command] of CONSTRAINT_SHORTCUTS) {
    const kind = command.replace(/^apply_/, '')
    const def = CONSTRAINT_BY_KIND.get(kind)
    rows.push({
      key,
      command,
      label: def ? `Apply ${def.label}` : command,
      description: def?.description ?? '',
    })
  }

  // Entity shortcuts — derive label/description from entity registry
  for (const [key, command] of ENTITY_SHORTCUTS) {
    const activeTool = command.replace(/^set_tool_/, '')
    const def = ENTITY_BY_ACTIVE_TOOL.get(activeTool)
    rows.push({
      key,
      command,
      label: def ? `${def.label} tool` : command,
      description: def?.description ?? '',
    })
  }

  return rows.sort((a, b) => a.key.localeCompare(b.key))
}

function KeybindingsTable() {
  const rows = buildKeybindingRows()
  return (
    <table className="reg-table">
      <thead>
        <tr>
          <th>Key</th>
          <th>Label</th>
          <th>Command</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ key, command, label, description }) => (
          <tr key={key}>
            <td><kbd className="reg-kbd">{key}</kbd></td>
            <td>{label}</td>
            <td><code>{command}</code></td>
            <td className="reg-cell-desc">{description}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ── Entities section ────

function EntitiesTable() {
  return (
    <table className="reg-table">
      <thead>
        <tr>
          <th>Icon</th>
          <th>Kind</th>
          <th>Label</th>
          <th>Params</th>
          <th>Vertices</th>
          <th>Tool</th>
          <th>Toolbar</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        {ENTITIES.map(e => (
          <tr key={e.kind}>
            <td className="reg-cell-icon"><Icon file={e.toolbarIcon} /></td>
            <td><code>{e.kind}</code></td>
            <td>{e.label}</td>
            <td className="reg-cell-center">{e.paramCount}</td>
            <td>
              {e.vertices.map(v => (
                <span key={v.key} className="reg-vertex-pill">
                  <code>{v.key}</code>
                  <span className="reg-vertex-idx">[{v.indices.join(',')}]</span>
                </span>
              ))}
            </td>
            <td>{e.activeTool ? <code>{e.activeTool}</code> : <span className="reg-muted">—</span>}</td>
            <td className="reg-cell-center">
              {e.showInToolbar
                ? <Badge text="yes" variant="yes" />
                : <Badge text="no" variant="no" />}
            </td>
            <td className="reg-cell-desc">{e.description}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ── Constraints section ────

function ConstraintsTable() {
  return (
    <table className="reg-table">
      <thead>
        <tr>
          <th>Symbol</th>
          <th>Toolbar</th>
          <th>Kind</th>
          <th>Label</th>
          <th>Category</th>
          <th>Shortcut</th>
          <th>Refs</th>
          <th>Value</th>
          <th>Render</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        {CONSTRAINTS.map(c => (
          <tr key={c.kind}>
            <td className="reg-cell-icon"><Icon file={c.symbolIcon} /></td>
            <td className="reg-cell-icon"><Icon file={c.toolbarIcon} /></td>
            <td><code>{c.kind}</code></td>
            <td>{c.label}</td>
            <td>
              <Badge
                text={c.category}
                variant={c.category === 'geometric' ? 'geo' : 'dim'}
              />
            </td>
            <td className="reg-cell-center">
              {c.shortcut
                ? <kbd className="reg-kbd">{c.shortcut.toUpperCase()}</kbd>
                : <span className="reg-muted">—</span>}
            </td>
            <td><code>{c.refPattern}</code></td>
            <td className="reg-cell-center">
              {c.hasValue
                ? <Badge text="yes" variant="yes" />
                : <Badge text="no" variant="no" />}
            </td>
            <td><code>{c.renderKind}</code></td>
            <td className="reg-cell-desc">{c.description}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ── Dimension rules section ────

function DimensionRulesTable() {
  return (
    <table className="reg-table">
      <thead>
        <tr>
          <th>Trigger</th>
          <th>Constraint Kind</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        {DIMENSION_RULES.map((r, i) => {
          const trigger = r.trigger.type === 'single_entity'
            ? <><code>single_entity</code> — kind: <code>{r.trigger.entityKind}</code></>
            : <code>{r.trigger.type}</code>
          return (
            <tr key={i}>
              <td>{trigger}</td>
              <td><code>{r.constraintKind}</code></td>
              <td>{r.description}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

// ── Snap rules section ────

function SnapRulesTable() {
  return (
    <table className="reg-table">
      <thead>
        <tr>
          <th>Dragged Element</th>
          <th>Snap Kinds</th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(SNAP_RULES).map(([draggedType, snapKinds]) => (
          <tr key={draggedType}>
            <td><code>{draggedType}</code></td>
            <td>{snapKinds.map(k => <Badge key={k} text={k} variant="neutral" />)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ── Measurements section ────

function MeasurementsTable() {
  return (
    <table className="reg-table">
      <thead>
        <tr>
          <th>Type</th>
          <th>Label</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td colSpan={3} className="reg-cell-section">Single Entity Rules</td>
        </tr>
        {SINGLE_ENTITY_RULES.map((r, i) => (
          <tr key={`single-${i}`}>
            <td><Badge text="single" variant="neutral" /></td>
            <td>{r.label}</td>
            <td className="reg-cell-desc">Measures individual entities</td>
          </tr>
        ))}
        <tr>
          <td colSpan={3} className="reg-cell-section">Multi-Entity Rules</td>
        </tr>
        {MULTI_ENTITY_RULES.map((r, i) => (
          <tr key={`multi-${i}`}>
            <td><Badge text="multi" variant="neutral" /></td>
            <td>{r.label}</td>
            <td className="reg-cell-desc">Measures entity pairs</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ── Page ────

const SECTIONS = [
  { id: 'constraints', label: 'Constraints' },
  { id: 'dim-rules',   label: 'Dimension Rules' },
  { id: 'entities',    label: 'Entities' },
  { id: 'snap-rules',  label: 'Snap Rules' },
  { id: 'measurements',label: 'Measurements' },
  { id: 'keybindings', label: 'Keybindings' },
] as const

export default function Registry() {
  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
  }

  return (
    <div className="registry-page">
      <AppHeader title="Registry" />

      <div className="reg-container">
        <nav className="reg-nav">
          <ul>
            {SECTIONS.map(s => (
              <li key={s.id}>
                <button className="reg-nav-link" onClick={() => scrollTo(s.id)}>
                  {s.label}
                </button>
              </li>
            ))}
          </ul>
          <div className="reg-nav-stats">
            <div>{CONSTRAINTS.length} constraints</div>
            <div>{ENTITIES.length} entity types</div>
            <div>{Object.keys(KEYMAP).length} keybindings</div>
          </div>
        </nav>

        <main className="reg-content">
          <h1>Registry</h1>
          <p className="reg-intro">
            Single source of truth for all constraint types, entity types, and keyboard commands.
            All toolbar buttons, shortcuts, icon mappings, and dimension-tool detection are derived from these tables.
          </p>

          <section id="constraints">
            <h2>Constraints <span className="reg-count">({CONSTRAINTS.length})</span></h2>
            <p>
              Every constraint recognised by the solver. The <strong>symbol</strong> icon appears on the canvas;
              the <strong>toolbar</strong> icon appears in the sketch toolbar.
              Dimensional constraints are accessed via the Dimension tool (D) and auto-detected by the rules below.
            </p>
            <div className="reg-table-wrap">
              <ConstraintsTable />
            </div>
          </section>

          <section id="dim-rules">
            <h2>Dimension Tool Rules <span className="reg-count">({DIMENSION_RULES.length})</span></h2>
            <p>
              When the Dimension tool is active, the constraint kind is chosen automatically based on what the user clicks.
            </p>
            <div className="reg-table-wrap">
              <DimensionRulesTable />
            </div>
          </section>

          <section id="entities">
            <h2>Entity Types <span className="reg-count">({ENTITIES.length})</span></h2>
            <p>
              Sketch entity types. <strong>Params</strong> is the flat array length used in the AST <code>initial</code> map.
              <strong>Vertices</strong> shows named sub-elements and their parameter indices.
            </p>
            <div className="reg-table-wrap">
              <EntitiesTable />
            </div>
          </section>

          <section id="snap-rules">
            <h2>Snap Rules <span className="reg-count">({SNAP_KINDS.length} kinds)</span></h2>
            <p>
              Defines where each entity vertex can snap and what constraint to suggest.
            </p>
            <div className="reg-table-wrap">
              <SnapRulesTable />
            </div>
          </section>

          <section id="measurements">
            <h2>Measurements <span className="reg-count">({SINGLE_ENTITY_RULES.length + MULTI_ENTITY_RULES.length} rules)</span></h2>
            <p>
              Rules for displaying measurements on the canvas. First matching rule wins.
            </p>
            <div className="reg-table-wrap">
              <MeasurementsTable />
            </div>
          </section>

          <section id="keybindings">
            <h2>Keybindings <span className="reg-count">({Object.keys(KEYMAP).length})</span></h2>
            <p>
              Global keyboard shortcuts. Constraint shortcuts are derived automatically from the constraint registry;
              core shortcuts are defined statically in <code>commandRegistry.ts</code>.
            </p>
            <div className="reg-table-wrap">
              <KeybindingsTable />
            </div>
          </section>
        </main>
      </div>
    </div>
  )
}
