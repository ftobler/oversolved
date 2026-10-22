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
(the queue) and `bugreports/mcp-practice/` (one directory per claimed item,
called the run directory below).
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
- Pick edges and faces with `select`, not by guessing query strings. The
  `mutations` fillet example uses positional `?body_ex1:edge:N` queries;
  do not copy that pattern, they break as soon as the topology changes.
- Check your progress with `measure` after each meaningful step.
- `compare` against a reference only if one is cheap to get (a CadQuery
  example run through `frontend/scripts/cadqueryReference.py`, see
  `docs/translate.md`; CadQuery is in `.venv`). Optional.
- At the end, `run` with `returnDoc: true` and save the document as
  `bugreports/mcp-practice/<slug>/doc.yaml` (or `.json`). Save intermediate
  documents that show a bug as `bugreports/mcp-practice/<slug>/bug-<n>.yaml`.

Budget: stop after about 60 tool calls or when you are stuck on the same
problem three times. A stuck run is a finding, not a failure.

## 4. Write the report

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
outcomes, and every finding grouped by kind and symptom key with the runs that
hit it. Summarise the top groups; turning a group into a bug or MCP plan is a
separate request.

## Licenses

You may read and model any example, whatever its license, including LGPL,
non-commercial and unlicensed collections: that is use, not distribution. The
license column only matters later, and the rule is fixed: nothing from these
runs enters the repo. A bug worth keeping is re-created from scratch by a
separate agent that sees only the finding text, never the example.
