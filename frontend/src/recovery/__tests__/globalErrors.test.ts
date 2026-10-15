//
// The window crash handlers against a plain target and fake-indexeddb: an
// uncaught throw and an unhandled rejection each land as a report, a resource
// load failure does not, and the uninstall takes the listeners down.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { installGlobalErrorHandlers, type GlobalErrorTarget } from '@/recovery/globalErrors'
import { listCrashReports } from '@/recovery/crashReports'
import { resetDbConnection } from '@/stores/documentStore/idb'

function freshDb(): void {
  globalThis.indexedDB = new IDBFactory()
  resetDbConnection()
}

beforeEach(freshDb)

interface FakeTarget extends GlobalErrorTarget {
  dispatch(type: string, event: Event): void
}

function makeTarget(): FakeTarget {
  const listeners = new Map<string, Set<(event: Event) => void>>()
  return {
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set()
      set.add(listener)
      listeners.set(type, set)
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener)
    },
    dispatch(type, event) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event)
    },
  }
}

// The report write is fire-and-forget from the handler; wait for it to land.
async function waitForReport(predicate: (message: string) => boolean) {
  return vi.waitFor(async () => {
    const reports = await listCrashReports()
    const match = reports.find(report => predicate(report.message))
    expect(match).toBeDefined()
    return match!
  })
}

describe('global error handlers', () => {
  it('records an uncaught window error with its stack', async () => {
    const target = makeTarget()
    const uninstall = installGlobalErrorHandlers(target)
    const error = new Error('kaboom in a timer')
    target.dispatch('error', new ErrorEvent('error', { message: error.message, error }))

    const report = await waitForReport(message => message === 'kaboom in a timer')
    expect(report.source).toBe('error')
    expect(report.stack).toContain('kaboom in a timer')
    uninstall()
  })

  it('records an unhandled rejection through its reason', async () => {
    const target = makeTarget()
    const uninstall = installGlobalErrorHandlers(target)
    const event = new Event('unhandledrejection')
    Object.assign(event, { reason: new Error('promise gave up') })
    target.dispatch('unhandledrejection', event)

    const report = await waitForReport(message => message === 'promise gave up')
    expect(report.source).toBe('rejection')
    uninstall()
  })

  it('ignores a resource load failure, which is not a crash', async () => {
    const target = makeTarget()
    const uninstall = installGlobalErrorHandlers(target)
    target.dispatch('error', new Event('error'))

    // Give a would-be write a chance to land before asserting nothing did.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await listCrashReports()).toHaveLength(0)
    uninstall()
  })

  it('stops recording after the uninstall', async () => {
    const target = makeTarget()
    const uninstall = installGlobalErrorHandlers(target)
    uninstall()

    const error = new Error('after uninstall')
    target.dispatch('error', new ErrorEvent('error', { message: error.message, error }))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await listCrashReports()).toHaveLength(0)
  })
})
