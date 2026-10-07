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
OCCT tree in `make.py` before compiling it. Both archives are served from this
site, next to the binary they build:

- [occt-V7_4_0p1.tar.gz](source/occt-V7_4_0p1.tar.gz)
  (sha256 `85b66265cd861147fdc6e428b01a917a37fc3902d2d06d73c7298b1ac9a2cb0d`)
- [opencascade.js-1.1.1-src.tar.gz](source/opencascade.js-1.1.1-src.tar.gz)
  (sha256 `7ce8617e77013c24ba4b32df7933094400a61fc96d143060634f1101f5ed6b93`)
- [SHA256SUMS](source/SHA256SUMS)

Upstream:

- <https://github.com/Open-Cascade-SAS/OCCT>
- <https://github.com/donalffons/opencascade.js>
