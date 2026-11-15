# Open CASCADE Technology

**This software makes use of and is based on facilities provided by the Open
CASCADE Technology software.**

Open CASCADE Technology is copyright Open CASCADE SAS and contributors, and is
licensed under the [GNU LGPL 2.1](LICENSE-LGPL-2.1.txt) with the
[Open CASCADE exception](OCCT-EXCEPTION.txt).

## What is distributed

`occt.js` and `occt.wasm`, served unmodified from `/occ/` exactly as published
in the `occt-8.0.1-r2` release of the oversolved-occt build, which compiles OCCT
`V8.0.1` (commit `b8f597c677811d1f9f4d8a97f5ae2825c0353a42`) to WebAssembly.
The release's own copies of the license texts, `LICENSE_LGPL_21.txt` and
`OCCT_LGPL_EXCEPTION.txt`, are served beside them.

The application loads them at runtime as a separate module. To run it on a
different build, replace those two files; `src/kernel/occ/importOccModule.ts`
shows the module shape the loader expects.

## Corresponding source

OCCT V8.0.1 together with the oversolved-occt build at the commit that produced
the binary (`1f3b7945504dbd4ca6baed97524f3fd7b3c22469`), which generates the
JavaScript bindings and holds the compile and link flags. Both archives are
served from this site, next to the binary they build:

- [occt-V8.0.1.tar.gz](source/occt-V8.0.1.tar.gz)
  (sha256 `6297cc55a1720523a437c54d07dc16b9da8c5f5ab5800da3c6ebded568d53c18`)
- [oversolved-occt-1f3b794-src.tar.gz](source/oversolved-occt-1f3b794-src.tar.gz)
  (sha256 `9c20fbce206f904b1601ab33ec8a96f6a0ef7fb6a2f18994a8b3e700a22e0294`)
- [SHA256SUMS](source/SHA256SUMS)

Upstream:

- <https://github.com/Open-Cascade-SAS/OCCT>
- <https://github.com/ftobler/oversolved-occt>
