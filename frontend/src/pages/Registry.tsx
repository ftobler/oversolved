import AppHeader from '@/components/layout/AppHeader'
import { CONSTRAINTS, ENTITIES, DIMENSION_RULES, SNAP_KINDS } from '@/registry'
import { SINGLE_ENTITY_RULES, MULTI_ENTITY_RULES } from '@/registry/measurementRegistry'
import { KEYMAP } from '@/utils/core/commandRegistry'
import '@/pages/Registry.css'
import { ConstraintsTable } from './registry/ConstraintsTable'
import { DimensionRulesTable } from './registry/DimensionRulesTable'
import { EntitiesTable } from './registry/EntitiesTable'
import { SnapRulesTable } from './registry/SnapRulesTable'
import { MeasurementsTable } from './registry/MeasurementsTable'
import { KeybindingsTable } from './registry/KeybindingsTable'

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
