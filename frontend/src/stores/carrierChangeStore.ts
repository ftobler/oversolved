import { create } from 'zustand'
import { getWorkspaceStore, type CarrierCheck, type OpenWorkspace } from '@/workspace/store'
import { useRecoveryStore } from '@/stores/recoveryStore'
import { errorMessage } from '@/utils/core/errorMessage'
import type { ReconcileReport } from '@/workspace/directoryCarrier'

// The P4 carrier-change check as a state machine. A workspace bound to a folder
// or zip can move underneath the working copy (an external editor, git, a sync
// client), so opening the workspace and refocusing its tab compares the carrier
// manifest fingerprint against the one the working copy last agreed with. A
// change is never resolved silently: the dialog offers the three explicit
// outcomes, and a change is only cleared by one of them.
//
// `unavailable` is the neutral sibling: a torn zip or an ungranted folder means
// the IDB working copy still opens, but no reload can succeed, so the state does
// not raise the change prompt.
//
// The state is keyed to a workspace so the page mounts the dialog only for the
// workspace it is showing, and a route change cannot leave a stale prompt.

export type CarrierChangeStatus = 'idle' | 'changed' | 'unavailable'

// A focus burst (focus plus visibilitychange, plus the browser's own repeats)
// must not read the carrier once per event. Checks are coalesced into one read.
export const CARRIER_CHECK_DEBOUNCE_MS = 150

let watchAttached = false
let checkTimer: ReturnType<typeof setTimeout> | null = null
// A later begin must win over an earlier one still in flight, so a route change
// cannot arm a prompt for the workspace the user just left.
let beginToken = 0

function scheduleCheck(): void {
  if (checkTimer) clearTimeout(checkTimer)
  checkTimer = setTimeout(() => {
    checkTimer = null
    void useCarrierChangeStore.getState().check().catch(() => undefined)
  }, CARRIER_CHECK_DEBOUNCE_MS)
}

function onVisibilityChange(): void {
  // A tab going hidden is not a moment the carrier can have moved under this
  // tab; only the return to visible is worth a read.
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  scheduleCheck()
}

function attachWatch(): void {
  if (watchAttached || typeof window === 'undefined') return
  watchAttached = true
  window.addEventListener('focus', scheduleCheck)
  document.addEventListener('visibilitychange', onVisibilityChange)
}

function detachWatch(): void {
  if (!watchAttached) return
  watchAttached = false
  window.removeEventListener('focus', scheduleCheck)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  if (checkTimer) {
    clearTimeout(checkTimer)
    checkTimer = null
  }
}

interface CarrierChangeState {
  status: CarrierChangeStatus
  workspace: string | null
  carrier?: 'folder' | 'zip'
  label?: string
  reconcile?: ReconcileReport
  // A resolution that failed, shown in the dialog so the user can retry or Save
  // As rather than lose the working copy to a carrier write that did not land.
  error?: string
  // Open the workspace, inspect the carrier-change evidence, and arm the focus
  // watch. Returns true when the change prompt is up, so the page holds U7 back
  // until the carrier decision is made. `unavailable` is neutral: the working
  // copy still opens, so it returns false and U7 runs normally.
  begin: (workspace: string) => Promise<boolean>
  // Re-run the compare now. An explicit workspace (the grid's Reopen) names the
  // workspace to surface; the focus watch and the tests call it without one.
  check: (workspace?: string) => Promise<void>
  reload: () => Promise<void>
  keep: () => Promise<void>
  saveOver: () => Promise<void>
  reset: () => void
}

export const useCarrierChangeStore = create<CarrierChangeState>((set, get) => {
  // Every resolution ends in recoveryStore.begin: Reload and Save over leave
  // working == checkpoint and will not prompt, while Keep sets carrierDiverged
  // and U7 may ask about the crash half independently. This is the precedence
  // the page relies on: carrier first, then U7.
  const resolve = async (run: (workspace: string) => Promise<void>): Promise<void> => {
    const workspace = get().workspace
    if (!workspace) return
    set({ error: undefined })
    try {
      await run(workspace)
    } catch (e) {
      set({
        status: 'changed',
        workspace,
        error: errorMessage(e, 'Failed to update the workspace carrier'),
      })
      return
    }
    set({ status: 'idle', workspace })
    void useRecoveryStore.getState().begin(workspace)
  }

  return {
    status: 'idle',
    workspace: null,
    begin: async (workspace) => {
      const token = ++beginToken
      let opened: OpenWorkspace
      try {
        opened = await getWorkspaceStore().open(workspace)
      } catch {
        if (token === beginToken) set({ status: 'idle', workspace: null, error: undefined })
        return false
      }
      if (token !== beginToken) return false
      attachWatch()
      if (opened.externalChanged) {
        set({
          status: 'changed',
          workspace,
          carrier: opened.carrierKind,
          label: opened.carrierLabel,
          reconcile: opened.reconcile,
          error: undefined,
        })
        return true
      }
      if (opened.carrierUnavailable) {
        set({ status: 'unavailable', workspace, carrier: opened.carrierKind, error: undefined })
        return false
      }
      set({ status: 'idle', workspace, error: undefined })
      return false
    },
    check: async (workspace?: string) => {
      const target = workspace ?? get().workspace
      if (!target) return
      let result: CarrierCheck
      try {
        result = await getWorkspaceStore().checkCarrier(target)
      } catch {
        // A carrier that cannot be read (a missing manifest, a revoked handle)
        // settles to unavailable rather than rejecting the focus watch on every
        // refocus. The same staleness rule as the success path applies.
        if (workspace === undefined && get().workspace !== target) return
        set({ status: 'unavailable', workspace: target })
        return
      }
      // The focus watch's implicit re-check can be overtaken by a route change:
      // its result is dropped once the user has left that workspace. An explicit
      // workspace (the grid's Reopen) is the caller's direct request and wins.
      if (workspace === undefined && get().workspace !== target) return
      if (result.status === 'changed') {
        set({
          status: 'changed',
          workspace: target,
          carrier: result.carrier,
          label: result.label,
          reconcile: result.reconcile,
        })
      } else if (result.status === 'unavailable') {
        set({ status: 'unavailable', workspace: target, carrier: result.carrier, label: result.label })
      } else if (get().status !== 'idle') {
        // The carrier is back to the state the working copy agrees with, so a
        // stale prompt from an earlier read is dropped.
        set({ status: 'idle', workspace: target })
      } else {
        // A clean explicit check still records the workspace it spoke for, so a
        // later focus event or page mount keys its own compare to the same one.
        set({ workspace: target })
      }
    },
    reload: () => resolve(workspace => getWorkspaceStore().reloadFromCarrier(workspace)),
    keep: () => resolve(workspace => getWorkspaceStore().keepWorkingCopy(workspace)),
    saveOver: () => resolve(workspace => getWorkspaceStore().saveOverCarrier(workspace)),
    reset: () => {
      beginToken++
      detachWatch()
      set({ status: 'idle', workspace: null, carrier: undefined, label: undefined, reconcile: undefined, error: undefined })
    },
  }
})
