// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// A simple stack tracker for nested editor modes.
// When the stack is empty ("main"), all transient state should be cleaned up.
// Invariant violations fail loud (throw in test, warn in dev).

import { failLoud } from './stateInvariants'

export interface ModeEntry {
  kind: string
}

export class ModeStack {
  private stack: ModeEntry[] = []

  get depth(): number {
    return this.stack.length
  }

  get current(): ModeEntry | null {
    return this.stack.length > 0 ? this.stack[this.stack.length - 1] : null
  }

  get isEmpty(): boolean {
    return this.stack.length === 0
  }

  push(kind: string): number {
    this.stack.push({ kind })
    return this.stack.length
  }

  pop(expectedKind?: string): ModeEntry {
    if (this.stack.length === 0) {
      const hint = expectedKind ? ` (expected '${expectedKind}')` : ''
      failLoud(`[modeStack] pop() called on empty stack${hint}`)
      throw new Error('Cannot pop from empty mode stack')
    }
    const entry = this.stack.pop()!
    if (expectedKind !== undefined && entry.kind !== expectedKind) {
      failLoud(
        `[modeStack] pop() expected '${expectedKind}' but top is '${entry.kind}'`,
      )
    }
    return entry
  }

  reset(): void {
    this.stack = []
  }

  getAll(): readonly ModeEntry[] {
    return this.stack
  }
}
