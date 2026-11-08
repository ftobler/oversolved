---
name: mcp-practice
description: Practice the Oversolved MCP server on one code-CAD example from scratch/code-cad-examples - claim an item from the practice queue, rebuild the part through the mcp__oversolved__* tools, and write a findings report. Use when asked to "do an MCP practice item", "practice the MCP", "rebuild an example through MCP", or to tally practice reports. Not for building test corpus cases.
---

# MCP practice

You are practising the Oversolved MCP server (`mcp__oversolved__*` tools) on
real code-CAD examples. Pick one example, rebuild the part it describes through
MCP the way a user would model it, and write down everything that got in your
way. This is practice, not parity: an approximate rebuild is fine, the point is
to hit ordinary modelling problems and report them.

This is not a test corpus. Nothing from a run is committed. Do not copy example
code or your rebuilt documents into the repo, and do not edit any repo file
outside `bugreports/mcp-practice/`. Do not fix bugs you find; report them.

Paths: this skill exists twice with identical content, in
`.claude/skills/mcp-practice/` and `.opencode/skills/mcp-practice/` (each
harness looks in its own folder); the commands below use the `.claude` copy of
the scripts, which works from any harness. The data is local and gitignored:
`scratch/code-cad-examples/` (the examples), `scratch/mcp-practice/queue.tsv`
(the queue), `bugreports/mcp-practice/` (one directory per claimed item,
called the run directory below) and `scratch/mcp-practice/scripts/` (the
script store, one directory per run that built something).

Both homes are permanent. A run directory stays in place after its findings
are triaged into plans or the backlog: it is the claim that keeps another run
off the same example, and the record the plan's findings point back to. The
plan is what gets deleted, when it ships. The script store is permanent too:
it is the replay set that later checks a
reimplementation of the mutation layer (the planned Rust document core) against
the TypeScript one, so a built or partial run normally leaves its script there.
If the queue is missing, generate it with
`bash .claude/skills/mcp-practice/build_queue.sh`. Run every command from the
repo root with explicit paths; do not `cd`.

## 1. Claim an item

`queue.tsv` lists the examples (`path`, `language`, `license`). Take the row
the user named, or choose any row you like. Claim it by creating its run
directory; `mkdir` without `-p` is atomic, so if it fails, someone else has it
and you pick another:

```bash
mkdir -p bugreports/mcp-practice
mkdir bugreports/mcp-practice/<slug>
```

`<slug>` is the example path below `scratch/code-cad-examples/` with `/`
replaced by `__` and the extension kept, e.g.
`02_cadquery__cadquery-contrib__examples__Parametric_Enclosure.py`.

## 2. Read the example and decide what to build

Read the source. If it does not describe a part (a library helper, a utility,
a docs page, an assembly of imported parts, something that needs features
Oversolved clearly lacks), still write a report with `outcome: skipped` and
the reason. That is a useful finding too.

Otherwise write down in one or two sentences what part you are going to
build and which simplifications you take (fewer holes, no thread, one
instance of an array...).

## 3. Model it through MCP

Before your first `run`, read `docs/drive.md` (section "MCP Server"), the
`mutations` tool output, and the resource `oversolved://schema/part-document`.
World is Y-up; the frames of the Top/Front/Right planes are in the server
instructions.

- Author with `run` steps, chain by `docHash`.
- Pick edges and faces with `select`, not by guessing query strings.
- Read `features` in every reply: a non-empty list is a finding (a feature failed, only partly
  applied, or warned while `ok` stayed true), so record its id, kind, status and message.
  `measure` returns the same list when you want the document's verdicts without a run.
- `compare` against a reference only if one is cheap to get (a CadQuery
  example run through `frontend/scripts/cadqueryReference.py`, see
  `docs/translate.md`; CadQuery is in `.venv`). Optional.
- At the end, `run` with `returnDoc: true` and save the document as
  `bugreports/mcp-practice/<slug>/doc.yaml` (or `.json`). Save intermediate
  documents that show a bug as `bugreports/mcp-practice/<slug>/bug-<n>.yaml`.
- Keep track of the `run` calls in the `docHash` chain that led to the final
  document, with their steps as sent: section 4 needs them.

Budget: stop after about 60 tool calls or when you are stuck on the same
problem three times. A stuck run is a finding, not a failure.

## 4. Keep the script

For a `built` or `partial` outcome, write one replayable script that rebuilds
the final document from an empty one. Skip this section for `skipped`, and for
`stuck` when nothing was built.

This is a soft rule. A run without a script is fine when the result does not
fit the script format or a replay cannot be made to pass within the budget
(for example a document that only exists through a path `run` steps cannot
express). Then say why in the report's Notes, one line, and move on; do not
spend the run's budget forcing a script.

1. Concatenate, in chain order, the steps of every `run` whose `docHash` led
   to the final document. Leave out refused runs and side branches you
   abandoned; keep failing steps only when the final document contains them
   (a `partial` result is still the document as you left it).
2. Replay it: `run` with those steps, no `doc` and no `docHash` (a fresh
   document; pass `kind`, `parts` or `files` the way the original runs did).
   Then `measure` the replay and the final document.
3. The replay passes when it is `ok`, its `features` list matches the final
   document's, and volume, area and bbox agree with the final document's
   at the 1e-6 level. The `docHash` may differ: minted ids are seeded per
   document and script, so one long script can mint other ids than a chain of
   short ones. If the replay fails, fix the script (usually a step that leaned
   on an id minted in an earlier run); if you cannot quickly, keep it anyway
   with `replay: failed`, or drop it under the soft rule above.

Save to `scratch/mcp-practice/scripts/<slug>/` (the same `<slug>` as the run
directory):

- `script.json`: `{ "steps": [...] }`, the format `run` takes and
  `npm run drive -- run script.json` replays (`docs/drive.md`, "Script
  format").
- For an assembly, one `part-<doc_id>.json` per part script and
  `assembly.json` as `{ "kind": "assembly", "parts": { "<doc_id>":
  "part-<doc_id>.json" }, "steps": [...] }`: the parts map names the part
  script files instead of a `docHash`, so a replay builds each part first and
  binds its hash. A STEP file passed in `files` is noted by its path under
  `scratch/code-cad-examples/`, not copied.
- `meta.json`: what a replay is checked against.

```json
{
  "example": "scratch/code-cad-examples/<path>",
  "outcome": "built",
  "date": "<YYYY-MM-DD>",
  "commit": "<git rev-parse --short HEAD at the time of the run>",
  "replay": "passed",
  "finalDocHash": "<docHash of the final document>",
  "replayDocHash": "<docHash of the replay>",
  "length_unit": "mm",
  "measure": { "volume": 0, "area": 0, "bbox": [[0, 0, 0], [0, 0, 0]] },
  "features": []
}
```

`measure` and `features` copy the final document's `measure` reply (the
assembly reply's aggregate measures for an assembly). The `commit` matters:
a later replay that drifts is compared against the code the script was made
with, so a drift is attributed to a change, not to the script.

## 5. Write the report

`bugreports/mcp-practice/<slug>/report.md`, exactly this shape so `tally.sh` can fold reports:

```markdown
---
example: scratch/code-cad-examples/<path>
license: <from queue.tsv>
outcome: built | partial | stuck | skipped
calls: <approximate number of MCP tool calls>
---

## Intent
What the example builds and what you chose to build.

## Findings

### F1 <kind>: <one-line symptom>
- kind: kernel-bug | mcp-friction | missing-capability | docs
- symptom key: <feature kind or tool> / <short error text or behaviour>
- steps: the minimal mutation steps or tool call that shows it
- expected / actual
- doc: bug-1.yaml (if saved)

### F2 ...

## Notes
Anything else: what worked well, what took many attempts, what you would
want the tool to tell you.
```

Kinds:
- **kernel-bug**: a solve fails, a body is wrong, a feature errors on input
  that should work.
- **mcp-friction**: the tool surface made it hard: unclear errors, a missing
  `select` predicate, chaining confusion, too many calls for a simple thing.
- **missing-capability**: Oversolved has no feature for what the example does.
- **docs**: the schema, catalog or docs said something wrong or left you
  guessing.

Keep the symptom key short and stable (`fillet / BRep_API: command not
done`, `select / no predicate for hole edges`) so the same problem from many
runs folds into one. Run `bash .claude/skills/mcp-practice/tally.sh` first
and reuse an existing key when your problem is the same one.

End by telling the user the outcome and the findings in a few lines.

## Tallying

When asked for the state of the practice runs rather than to do one:
`bash .claude/skills/mcp-practice/tally.sh` prints claimed/reported counts,
the number of kept scripts and how many failed their replay, outcomes, and
every finding grouped by kind and symptom key with the runs that hit it. Summarise the top groups; turning a group into a bug or MCP plan is a
separate request.

## Licenses

You may read and model any example, whatever its license, including LGPL,
non-commercial and unlicensed collections: that is use, not distribution. The
license column only matters later, and the rule is fixed: nothing from these
runs enters the repo. The kept scripts are derived from the examples, so they
fall under the same rule: they live in the gitignored `scratch/` and are never
committed, copied into a test, or turned into a fixture. A bug worth keeping is re-created from scratch by a
separate agent that sees only the finding text, never the example.
