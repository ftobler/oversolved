# Compiler and runtime code in the WebAssembly

Two of the things Oversolved ships are compiled binaries: the OpenCascade
kernel at `/occ/` and the Rust solvers at `/wasm/`. Compiling a program links
parts of its toolchain into the result, so those binaries carry code that was
never a declared dependency of anything and that neither `npm` nor `cargo` will
name. It is distributed all the same, and it is credited here.

| Component | In | License | Text |
| --- | --- | --- | --- |
| Rust standard library (`std`, `core`, `alloc`) | `/wasm/*.wasm` | MIT OR Apache-2.0 | [MIT](LICENSE-rust-MIT.txt), [Apache-2.0](LICENSE-rust-Apache-2.0.txt) |
| Emscripten runtime and its libc | `/occ/opencascade.wasm.js`, `/occ/opencascade.wasm.wasm` | MIT or NCSA | [LICENSE-emscripten.txt](LICENSE-emscripten.txt) |
| LLVM libc++ and libc++abi | `/occ/opencascade.wasm.wasm` | Apache-2.0 WITH LLVM-exception | [LICENSE-libcxx...txt](LICENSE-libcxx-Apache-2.0-with-LLVM-exception.txt) |

## Rust standard library

The solver crates are `no_main` WebAssembly, but they are not `no_std`: the
standard library is statically linked into both `sketch_solver_bg.wasm` and
`mate_solver_bg.wasm`. The binaries still carry its source paths, which is the
simplest way to see it:

```
strings -n 8 public/wasm/sketch_solver_bg.wasm | grep -o 'library/(std|core|alloc)'
```

`cargo metadata` never reports `std`, `core` or `alloc` as packages, because
they come from the toolchain rather than from the dependency graph. That is why
they are written down here by hand instead of appearing in
[../cargo/LICENSES.txt](../cargo/LICENSES.txt), which is generated from that
graph and cannot see them.

Copyright is retained by the Rust project's contributors rather than assigned,
so there is no single holder to name. The project records authorship in its
version control history and at <https://thanks.rust-lang.org>. The library is
offered as MIT or Apache-2.0 at the recipient's choice, and both texts are
published above, as the Rust toolchain itself distributes them.

Code from `compiler_builtins`, `dlmalloc` and a vendored `libc` is compiled
into the standard library for this target and travels with it under the same
terms.

## Emscripten

`opencascade.wasm.js` is not hand-written glue. It is the Emscripten JavaScript
runtime: the module loader, the WebAssembly instantiation, the heap views and
the Embind bindings that make OCCT callable from JavaScript. Emscripten's own
libc is compiled into the `.wasm` beside it.

Emscripten is offered under the MIT license or the University of Illinois NCSA
Open Source License, at the recipient's choice, and the file above carries both
texts as Emscripten publishes them. Copyright is held by the Emscripten authors.

opencascade.js does not carry this notice itself: its package declares
`LGPL-2.1-only` and ships the bare LGPL text, which covers OCCT rather than the
toolchain that compiled it. The notice is therefore given here.

## libc++ and libc++abi

OCCT is C++, so the LLVM C++ standard library is linked into
`opencascade.wasm.wasm`. Its mangled symbols are visible in the binary
(`NSt3__2...`, `__cxa_...`).

libc++ is Apache-2.0 with the LLVM exception, and the exception matters here.
Its own words:

> As an exception, if, as a result of your compiling your source code, portions
> of this Software are embedded into an Object form of such source code, you
> may redistribute such embedded portions in such Object form without complying
> with the conditions of Sections 4(a), 4(b) and 4(d) of the License.

That is exactly this situation: libc++ is embedded in an object form produced by
compiling. The conditions Apache-2.0 would otherwise impose, to carry the
license with the copy, to mark changes and to propagate the NOTICE file, are
waived for it. The text is published above regardless, because a reader
inspecting the binary should be able to find out what it is looking at without
taking anyone's word for it.

## What is not in here

FreeType is not. opencascade.js fetches the FreeType headers during its build
and passes them to CMake as include directories only; no FreeType library is
compiled and no `FT_*` symbol appears in the shipped `.wasm`. The FreeType
license's acknowledgement condition attaches to distributing FreeType code, so
it does not attach here. It is written down because it is the first thing
anyone auditing an OCCT build will look for.
