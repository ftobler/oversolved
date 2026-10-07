# Third-party notices

**This software makes use of and is based on facilities provided by the Open
CASCADE Technology software.**

Oversolved is not open source, but it is built on software that is. The license
terms of everything it ships are published here in full.

| Component | License | Terms |
| --- | --- | --- |
| Open CASCADE Technology V7_4_0p1 (geometry kernel) | LGPL 2.1 with the Open CASCADE exception | [opencascade/](opencascade/) |
| npm packages (React, three.js, MUI, ...) | mostly MIT | [npm/LICENSES.txt](npm/LICENSES.txt) |
| Rust crates in the solvers (nalgebra, serde, ...) | mostly MIT or Apache-2.0 | [cargo/LICENSES.txt](cargo/LICENSES.txt) |
| Rust std, Emscripten, libc++ (compiled into the WebAssembly) | MIT, Apache-2.0, NCSA | [toolchain/](toolchain/) |
| Roboto, Roboto Mono | SIL Open Font License 1.1 | [npm/LICENSES.txt](npm/LICENSES.txt), [roboto-LICENSE.txt](../fonts/roboto-LICENSE.txt) |
| Material Icons, Material Icons Outlined | Apache License 2.0 | [npm/LICENSES.txt](npm/LICENSES.txt) |
| Studio Kominka 02 environment map, by Grzegorz Wronkowski | CC0 1.0 | [env_hdr.md](../env_hdr.md) |

Packages that declare a license without shipping its text point at the
canonical copy in [spdx/](spdx/).

`npm/` and `cargo/` are generated from the dependency graphs with
`npm run licenses:generate`; the tests fail if they drift.
