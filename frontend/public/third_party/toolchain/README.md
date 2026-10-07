# Compiler and runtime code

The compiled WebAssembly links in parts of the toolchains that built it.

| Component | In | License | Text |
| --- | --- | --- | --- |
| Rust standard library | `/wasm/*.wasm` | MIT OR Apache-2.0 | [MIT](LICENSE-rust-MIT.txt), [Apache-2.0](LICENSE-rust-Apache-2.0.txt) |
| Emscripten runtime and libc | `/occ/opencascade.wasm.*` | MIT OR NCSA | [LICENSE-emscripten.txt](LICENSE-emscripten.txt) |
| LLVM libc++ and libc++abi | `/occ/opencascade.wasm.wasm` | Apache-2.0 WITH LLVM-exception | [LICENSE-libcxx...txt](LICENSE-libcxx-Apache-2.0-with-LLVM-exception.txt) |
