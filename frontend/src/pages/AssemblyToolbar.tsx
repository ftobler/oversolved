import { useState } from 'react'
import AppHeader from '@/components/layout/AppHeader'

interface AssemblyToolbarProps {
  readOnly: boolean
  docName: string | null
  onRename: (name: string) => Promise<boolean>
  handleSave: () => void
  handleClone: () => void
}

// Assembly counterpart to PartToolbar: the same AppHeader shell (logo, burger,
// account) with the save / clone / rename controls, so the assembly editor wears
// the same titlebar as the part editor. Assemblies have no undo stack yet, so
// the undo/redo group is intentionally absent.
export default function AssemblyToolbar({
  readOnly,
  docName,
  onRename,
  handleSave,
  handleClone,
}: AssemblyToolbarProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(docName ?? '')
  const [saveState, setSaveState] = useState<'idle' | 'success'>('idle')

  const handleSaveClick = () => {
    handleSave()
    setSaveState('success')
    setTimeout(() => setSaveState('idle'), 1500)
  }

  const handleRename = async () => {
    const trimmed = editName.trim()
    if (!trimmed || trimmed === docName) {
      setIsEditing(false)
      return
    }
    const success = await onRename(trimmed)
    if (success) {
      setIsEditing(false)
    } else {
      setEditName(docName ?? '')
    }
  }

  return (
    <AppHeader>
      <button className="toolbar-btn" aria-label="Save" title="Save" onClick={handleSaveClick} disabled={readOnly}>
        <span className="material-icons-outlined">{saveState === 'success' ? 'check' : 'save'}</span>
      </button>
      <button className="toolbar-btn" aria-label="Clone document" title="Clone document" onClick={handleClone}>
        <span className="material-icons-outlined">file_copy</span>
      </button>
      {readOnly && (
        <span className="doc-name" style={{ color: '#ef5350', fontSize: '12px', marginLeft: '8px' }}>
          <span className="material-icons-outlined" style={{ fontSize: '14px', verticalAlign: 'middle' }}>lock</span>
          {' '}View Only
        </span>
      )}
      {isEditing ? (
        <input
          className="doc-name-input"
          value={editName}
          onChange={e => setEditName(e.target.value)}
          onBlur={handleRename}
          onKeyDown={e => {
            if (e.key === 'Enter') handleRename()
          }}
          autoFocus
        />
      ) : (
        <button className="doc-name" aria-label="Edit document name" onClick={() => {
          setEditName(docName ?? '')
          setIsEditing(true)
        }}>
          {docName || 'Untitled Assembly'}
        </button>
      )}
    </AppHeader>
  )
}
