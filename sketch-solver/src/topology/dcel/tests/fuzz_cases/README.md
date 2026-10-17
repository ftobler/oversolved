# Fuzz cases

Minimised reproductions found by the seeded area-builder fuzz
(`sketch-solver/src/topology/fuzz.rs`). Each `<seed>.json` is an input in the
`detect_topology_bytes` format; the sibling `<seed>.txt` is the violation text
that input still produces. `<seed>-<class>.json` is the minimisation for one
violation class when a seed fails more than one.

`fuzz_cases_regress` re-runs every case through the oracle and asserts its
recorded violations EQUAL the pending ones for that class (an extra one fails
too, so a case cannot hide behind its recorded lines). A case that stops
reproducing (a fix landed) fails that test on purpose: delete the case, and
remove the seed's `KNOWN_FAILING_SEEDS` entry in `fuzz.rs` in the same commit.

The PR sweep (`fuzz_seeds_0_300`) judges every seed of the PR range against the
`KNOWN_FAILING_SEEDS` catalogue: a failure with a class outside the seed's
entry, a catalogued seed that goes clean, and a clean seed that starts failing
all fail the sweep. Only coverage, structure and euler entries must have a
minimised fixture here; stability and order entries are catalogue-only (they
are numerous and the most seed-sensitive), so their fixtures, if present, are
bonus regressions.

Harvest a new range with `just sketch-fuzz <from> <to>`, which minimises each
new failure, writes the required-class fixtures here, and prints the catalogue
entries to add to `fuzz.rs` for review.
