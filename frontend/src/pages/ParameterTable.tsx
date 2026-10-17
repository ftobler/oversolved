// The parameter table: a part's variables as editable rows (name, expression,
// unit) with their solved values read-only beside them. A view, not a document
// of its own: every edit goes out as the mutation for that cell, so the table
// records one undo entry per change exactly like the feature tree does.
//
// Rows come from the pure model (partParameters.ts) and edits from its
// mutation builders, so the dialog holds no logic of its own beyond commit-on-
// blur (a half-typed expression must not be written on every keystroke: the
// solver would red the variable out on each one).

import { useState } from 'react'
import Dialog from '@/components/dialogs/Dialog'
import type { Mutation } from '@/types/cad'
import { parameterEditMutations, parameterValueText, UNIT_OPTIONS, type ParameterRow } from '@/pages/partParameters'
import './ParameterTable.css'

export default function ParameterTable({
  isOpen,
  rows,
  onClose,
  onMutation,
  onAdd,
}: {
  isOpen: boolean
  rows: readonly ParameterRow[]
  onClose: () => void
  onMutation: (m: Mutation) => void
  // Appends a parameter (the caller mints the feature id and dispatches
  // add_variable). A click, not a field: nothing to commit on blur.
  onAdd: () => void
}) {
  // The cell being edited, its draft text and the value it started from. All
  // three are transient: the doc holds the committed value, this holds the
  // keystrokes. `baseline` is what tells an unchanged edit from a changed one,
  // and a baseline the doc no longer matches (the doc was rewritten while the
  // field was open) abandons the draft instead of clobbering the document.
  const [draft, setDraft] = useState<{ id: string; field: 'name' | 'expression' | 'unit'; text: string; baseline: string } | null>(null)

  const commit = (row: ParameterRow, field: 'name' | 'expression' | 'unit'): void => {
    if (draft === null || draft.id !== row.id || draft.field !== field) return
    const { text, baseline } = draft
    setDraft(null)
    const stored = field === 'name' ? row.name : field === 'expression' ? row.expression : row.unit
    if (text === baseline || baseline !== stored) return
    for (const mutation of parameterEditMutations(row, field, text)) onMutation(mutation)
  }

  const cell = (row: ParameterRow, field: 'name' | 'expression' | 'unit', label: string) => {
    const stored = field === 'name' ? row.name : field === 'expression' ? row.expression : row.unit
    const editing = draft !== null && draft.id === row.id && draft.field === field
    const shown = editing && draft.baseline === stored ? draft.text : stored
    return (
      <input
        className="parameter-table-cell-input"
        aria-label={`${label} of ${row.name}`}
        value={shown}
        spellCheck={false}
        onChange={(e) => setDraft({ id: row.id, field, text: e.target.value, baseline: stored })}
        onFocus={() => setDraft({ id: row.id, field, text: stored, baseline: stored })}
        onBlur={() => commit(row, field)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          // Escape abandons the draft: dropping it re-reads the stored value on
          // the next render, and the blur's commit sees no draft.
          if (e.key === 'Escape') {
            setDraft(null)
            e.currentTarget.blur()
          }
        }}
      />
    )
  }

  return (
    <Dialog
      isOpen={isOpen}
      title="Parameters"
      icon="functions"
      onClose={onClose}
      onConfirm={onClose}
      confirmLabel="Close"
      showCancel={false}
      className="parameter-table-dialog"
    >
      {rows.length === 0 ? (
        <p className="parameter-table-empty">
          No parameters yet. Add one to name a value (a width, a wall thickness) and
          reference it from any numeric field as a formula.
        </p>
      ) : (
        <table className="parameter-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Expression</th>
              <th scope="col">Unit</th>
              <th scope="col">Value</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{cell(row, 'name', 'Name')}</td>
                <td>{cell(row, 'expression', 'Expression')}</td>
                <td>
                  <span className="parameter-table-unit">
                    {cell(row, 'unit', 'Unit')}
                    <select
                      className="parameter-table-unit-pick"
                      aria-label={`Unit hint of ${row.name}`}
                      value=""
                      onChange={(e) => {
                        const picked = e.target.value
                        if (picked === '') return
                        for (const mutation of parameterEditMutations(row, 'unit', picked)) onMutation(mutation)
                      }}
                    >
                      <option value="">unit...</option>
                      {UNIT_OPTIONS.filter((u) => u !== '').map((u) => (
                        <option key={u} value={u}>{u}</option>
                      ))}
                    </select>
                  </span>
                </td>
                <td className={`parameter-table-value${row.error !== null ? ' parameter-table-value--error' : ''}`}>
                  {parameterValueText(row)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button className="parameter-table-add" onClick={onAdd}>Add parameter</button>
    </Dialog>
  )
}
