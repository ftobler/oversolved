# Fuzz cases

Minimised reproductions found by the seeded area-builder fuzz
(`sketch-solver/src/topology/fuzz.rs`). Each `<seed>.json` is an input in the
`detect_topology_bytes` format; the sibling `<seed>.txt` is the violation text
that input still produces. `<seed>-<class>.json` is the minimisation for one
violation class when a seed fails more than one.

`fuzz_cases_regress` re-runs every case through the oracle and asserts the
recorded violations still occur. A case that stops reproducing (a fix landed)
fails that test on purpose: delete the case, and remove the class from
`ACCEPTED_CLASSES` in `fuzz.rs` in the same commit. The sweep accepts a failing
seed whose classes all have a checked-in case, so a new failure can never hide
behind these files without the class being accepted first.

Harvest a new range with `just sketch-fuzz <from> <to>`, which minimises each
new failure and writes the case here for review.
