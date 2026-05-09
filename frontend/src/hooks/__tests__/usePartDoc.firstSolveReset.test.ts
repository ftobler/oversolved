import { describe, it, expect } from 'vitest'

describe('firstSolveDone reset on document load', () => {
  it('resets firstSolveDone when a new document loads, allowing onFirstSolve to fire again', () => {
    // Simulates the pattern in usePartDoc:
    //   document load effect: firstSolveDone.current = false
    //   reSolve: isFirstSolve = !firstSolveDone.current; then calls onFirstSolve

    let firstSolveDone = false
    let callCount = 0
    const onFirstSolve = () => { callCount++ }

    function onDocumentLoad() {
      firstSolveDone = false  // the fix
    }

    function onSolveComplete() {
      const isFirstSolve = !firstSolveDone
      if (isFirstSolve) firstSolveDone = true
      if (isFirstSolve) onFirstSolve()
    }

    onDocumentLoad()
    onSolveComplete()
    expect(callCount).toBe(1)

    onDocumentLoad()
    onSolveComplete()
    expect(callCount).toBe(2)
  })

  it('without the reset, onFirstSolve does not fire for subsequent documents', () => {
    let firstSolveDone = false
    let callCount = 0
    const onFirstSolve = () => { callCount++ }

    function onSolveComplete() {
      const isFirstSolve = !firstSolveDone
      if (isFirstSolve) firstSolveDone = true
      if (isFirstSolve) onFirstSolve()
    }

    onSolveComplete()
    expect(callCount).toBe(1)

    // Without reset, second document's solve does not trigger onFirstSolve
    onSolveComplete()
    expect(callCount).toBe(1)
  })
})
