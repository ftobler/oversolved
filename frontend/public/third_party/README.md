# Third-party notices

Oversolved is not open source, but it is built on software that is. This folder
is where that software is credited and where its license terms are published in
full.

Serving the app is what makes this necessary. There is no server and no install
step, so every visitor's browser downloads the whole program: the geometry
kernel, the rendering stack, the fonts. That download is a distribution, and
most of these licenses require their terms to travel with the copy. They are
published here rather than summarised, because a summary is not a license.

This folder is deployed with the app, so the same files answer both a reader of
the source and a user of the running program.

## Open CASCADE Technology

**This software makes use of and is based on facilities provided by the Open
CASCADE Technology software.**

Open CASCADE Technology is the geometry kernel. Everything Oversolved knows
about solids, faces, edges and booleans, it knows through OCCT.

| | |
| --- | --- |
| Copyright | Open CASCADE SAS and contributors |
| License | GNU LGPL 2.1, with the Open CASCADE exception |
| Version | OCCT V7_4_0p1, compiled to WebAssembly by opencascade.js 1.1.1 |
| Terms | [LICENSE-LGPL-2.1.txt](opencascade/LICENSE-LGPL-2.1.txt), [OCCT-EXCEPTION.txt](opencascade/OCCT-EXCEPTION.txt) |
| Source and provenance | [opencascade/](opencascade/) |

The notice above is not decoration. The Open CASCADE exception grants its
permission on the express condition that a work using OCCT says prominently
that it does, so that sentence is part of the terms Oversolved accepts.

What Oversolved ships is the unmodified pair `opencascade.wasm.js` and
`opencascade.wasm.wasm`, exactly as opencascade.js publishes them, served as a
separate module and loaded at runtime. Nothing of OCCT is compiled into the
application bundle, and replacing those two files replaces the kernel. The
kernel stays under the LGPL; the application that calls it does not fall under
it. See [opencascade/](opencascade/) for the full account, including where to
get the corresponding source.

## Fonts

| Font | Copyright | License |
| --- | --- | --- |
| Roboto | The Roboto Project Authors | SIL Open Font License 1.1 |
| Roboto Mono | The Roboto Project Authors | SIL Open Font License 1.1 |
| Material Icons | Google Inc. | SIL Open Font License 1.1 |
| Material Icons Outlined | Google Inc. | SIL Open Font License 1.1 |

These arrive through the `@fontsource` packages and are bundled into the app, so
their license texts sit with the rest of the npm dependencies in
[npm/LICENSES.txt](npm/LICENSES.txt).

One Roboto weight is also served as a standalone file for the viewport labels,
which cannot wait for a stylesheet. Its license is published beside it, at
[../fonts/roboto-LICENSE.txt](../fonts/roboto-LICENSE.txt).

## Environment map

The studio lighting is [Studio Kominka 02](https://polyhaven.com/a/studio_kominka_02)
by Grzegorz Wronkowski, released under CC0 1.0. CC0 asks for nothing, so the
credit here is owed to the author rather than to the license. Details are in
[../env_hdr.md](../env_hdr.md).

## npm dependencies

[npm/LICENSES.txt](npm/LICENSES.txt) reproduces the license of every package in
the production dependency graph, which is every package whose code can reach a
browser: React, three.js, MUI, Zustand, JSZip, mathjs and their transitive
dependencies. React and three.js and most of the rest are MIT; the file has the
exact terms and the exact copyright holders.

Build and test tooling is deliberately absent. TypeScript, Vitest and ESLint run
on a developer's machine and would only bury the packages that ship. The one
qualification worth making is that a bundler leaves a little of itself behind:
Vite and Rollup inject small runtime helpers, a module-preload polyfill and
interop shims into the built JavaScript. Both are MIT, and their terms are the
same MIT terms reproduced many times over in the file above.

A few packages declare a license without shipping its text. Their entries name
the license and the copyright holder, and point at a canonical copy of the terms
in [spdx/](spdx/). Nothing there is attributed to anyone who did not claim it.

## Rust crates in the solvers

The sketch and mate solvers are Rust, compiled to WebAssembly and served from
`/wasm/`. Their dependencies are linked into that binary rather than loaded at
runtime, which makes them no less distributed than React is.
[cargo/LICENSES.txt](cargo/LICENSES.txt) reproduces the license of every crate
in their dependency graphs: nalgebra and its numeric stack, serde, wasm-bindgen
and the rest, most of them offered as MIT or Apache-2.0 at the user's choice.

That file is generated from the graph, so it errs towards listing too much: a
few build-time crates such as `syn` and `proc-macro2` appear there although they
only ever ran on the machine that compiled the solvers. Listing a crate that
owes nothing is harmless; the reverse would not be.

`sketch-solver`, `mate-solver` and `solver-core` are Oversolved's own crates and
are not listed there. They are covered by the repository's LICENSE.md.

## Compiler and runtime code

The two WebAssembly binaries also carry code from the toolchains that built
them: the Rust standard library in the solvers, and the Emscripten runtime and
LLVM's libc++ in the OpenCascade artifacts. None of it is a declared dependency
of anything, so neither generated bundle can see it, and it ships regardless.
[toolchain/](toolchain/) credits it and publishes its licenses.

## How this folder is maintained

`npm/LICENSES.txt` and `cargo/LICENSES.txt` are generated from the real
dependency graphs by the scripts in `frontend/scripts/`, and committed. Tests
regenerate both and fail if a committed copy has drifted, so a new dependency
cannot reach a deployment without bringing its license along.

Everything else here is written by hand, because it covers software that npm
cannot see: OCCT is installed out of band, and the environment map is an asset.
Those entries change only when the pinned versions change, and a test guards
that pin too.

To update after changing dependencies:

```bash
npm run licenses:generate
```
