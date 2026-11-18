# Open CASCADE Technology

**This software makes use of and is based on facilities provided by the Open
CASCADE Technology software.**

Open CASCADE Technology is copyright Open CASCADE SAS and contributors, and is
licensed under the [GNU LGPL 2.1](LICENSE-LGPL-2.1.txt) with the
[Open CASCADE exception](OCCT-EXCEPTION.txt).

## What is distributed

`occt.js` and `occt.wasm`, served unmodified from `/occ/` exactly as published
in the `occt-8.0.1-r3` release of the oversolved-occt build, which compiles OCCT
`V8.0.1` (commit `b8f597c677811d1f9f4d8a97f5ae2825c0353a42`) to WebAssembly.
The release's own copies of the license texts, `LICENSE_LGPL_21.txt` and
`OCCT_LGPL_EXCEPTION.txt`, are served beside them.

The application loads them at runtime as a separate module. To run it on a
different build, replace those two files; `src/kernel/occ/importOccModule.ts`
shows the module shape the loader expects.

## Corresponding source

OCCT V8.0.1 together with the oversolved-occt build at the commit that produced
the binary (`2d888f36721be579263a7e6b8854e7738cf1d575`), which generates the
JavaScript bindings and holds the compile and link flags. Both archives are
served from this site, next to the binary they build:

- [occt-V8.0.1.tar.gz](source/occt-V8.0.1.tar.gz)
  (sha256 `6297cc55a1720523a437c54d07dc16b9da8c5f5ab5800da3c6ebded568d53c18`)
- [oversolved-occt-2d888f3-src.tar.gz](source/oversolved-occt-2d888f3-src.tar.gz)
  (sha256 `1c15ee3e1d500e80406e4390d6c31c66396738579e830b1c98750181553de5aa`)
- [SHA256SUMS](source/SHA256SUMS)

Upstream:

- <https://github.com/Open-Cascade-SAS/OCCT>
- <https://github.com/ftobler/oversolved-occt>
