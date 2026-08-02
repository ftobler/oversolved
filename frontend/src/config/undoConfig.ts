// The undo history cap, in its own dependency-free module so a test can mock it
// down without re-implementing the hook. A plain `redo.length <= 50` assertion
// is vacuous (it also passes for an empty stack); a mocked-down constant makes
// the cap behavior observable.
export const MAX_UNDO_DEPTH = 50
