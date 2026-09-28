import { useEffect, useRef, useState } from 'react'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import '@/components/layout/AppHeader.css'

interface SaveButtonProps {
  // The editor's save, resolving to whether the bytes actually landed.
  save: () => boolean | Promise<boolean>
}

// The one Save control, rendered by the part and assembly toolbars. It carries
// the unsaved-changes state itself by tinting its icon, so there is no separate
// dot beside it and no second save button in the header. Its accessible name
// stays "Save" in both states; the title (read as its description) says when
// edits are pending.
export default function SaveButton({ save }: SaveButtonProps) {
  const dirty = useUnsavedChangesStore(s => s.dirty)
  const [saveState, setSaveState] = useState<'idle' | 'success'>('idle')
  // A save is a store write plus a solve-side diff; without this, a double
  // click starts two. The button refuses while one is in flight.
  const [saving, setSaving] = useState(false)
  // Tracks the pending "success" -> "idle" reset so it can be cleared on
  // unmount. Without this a stray timer fires setState after the component
  // (and, in tests, the whole jsdom environment) is gone.
  const saveResetTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The save resolves after an await, so it can outlive this component; any
  // state work past that await checks this ref. Re-armed in the effect body so
  // StrictMode's mount/unmount/mount replay cannot leave it stuck false.
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (saveResetTimeout.current !== null) clearTimeout(saveResetTimeout.current)
    }
  }, [])

  const handleClick = async () => {
    if (saving) return
    // A new attempt retires any previous success flash up front; only this
    // save's own outcome may bring the check back.
    setSaveState('idle')
    setSaving(true)
    try {
      // The green check means the bytes landed: only a resolved true may flash
      // it. On a failure the plain save icon stays; the error banner beside the
      // toolbar already reports why, so no second affordance is raised here.
      // Dirty is left to the save itself, which keeps it set when an edit
      // landed while the bytes were in flight.
      const saved = await save()
      // A resolve after unmount must not schedule the reset timer: the cleanup
      // already ran and nothing would ever clear it.
      if (!saved || !mountedRef.current) return
      setSaveState('success')
      if (saveResetTimeout.current !== null) clearTimeout(saveResetTimeout.current)
      saveResetTimeout.current = setTimeout(() => setSaveState('idle'), 1500)
    } finally {
      if (mountedRef.current) setSaving(false)
    }
  }

  return (
    <button
      className={dirty ? 'toolbar-btn save-btn dirty' : 'toolbar-btn save-btn'}
      data-dirty={dirty ? 'true' : undefined}
      aria-label="Save"
      title={dirty ? 'Save (unsaved changes)' : 'Save'}
      onClick={() => { void handleClick() }}
      disabled={saving}
    >
      <span className="material-icons-outlined">{saveState === 'success' ? 'check' : 'save'}</span>
    </button>
  )
}
