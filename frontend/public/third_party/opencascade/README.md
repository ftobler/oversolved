# Open CASCADE Technology

**This software makes use of and is based on facilities provided by the Open
CASCADE Technology software.**

Open CASCADE Technology is copyright Open CASCADE SAS and contributors, and is
licensed under the [GNU LGPL 2.1](LICENSE-LGPL-2.1.txt) with the
[Open CASCADE exception](OCCT-EXCEPTION.txt).

## What is distributed

`opencascade.wasm.js` and `opencascade.wasm.wasm`, served unmodified from
`/occ/` exactly as published by `opencascade.js@1.1.1`, which builds OCCT
`V7_4_0p1` (commit `33d9a6fa21ca4fa711da7066655aa2ba854545ee`).

The application loads them at runtime as a separate module. To run it on a
different build, replace those two files; `src/kernel/occ/loadOccWeb.ts` shows
the module shape the loader expects.

## Corresponding source

OCCT V7_4_0p1 together with the opencascade.js 1.1.1 build, which patches the
OCCT tree in `make.py` before compiling it. Both archives are mirrored as
release assets of the repository that publishes this application:

**Release `occ-source-v7_4_0p1`: MIRROR_RELEASE_URL_PENDING**

Upstream:

- <https://github.com/Open-Cascade-SAS/OCCT>
- <https://github.com/donalffons/opencascade.js>
