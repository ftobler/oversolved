# Open CASCADE Technology

**This software makes use of and is based on facilities provided by the Open
CASCADE Technology software.**

Open CASCADE Technology is the geometry kernel behind every solid, face, edge
and boolean in Oversolved. It is copyright Open CASCADE SAS and contributors,
and it is free software under the GNU Lesser General Public License, version
2.1, with an additional exception granted by its authors.

## What is published here

| File | What it is |
| --- | --- |
| [LICENSE-LGPL-2.1.txt](LICENSE-LGPL-2.1.txt) | The GNU LGPL 2.1, as shipped by opencascade.js |
| [OCCT-EXCEPTION.txt](OCCT-EXCEPTION.txt) | The Open CASCADE exception version 1.0, from the OCCT source distribution |

## What Oversolved distributes

Two files, both served from `/occ/` and both byte-for-byte as published by
opencascade.js:

| File | Origin |
| --- | --- |
| `opencascade.wasm.wasm` | OCCT compiled to WebAssembly |
| `opencascade.wasm.js` | the Emscripten loader and Embind bindings for it |

They are copied out of the npm package by `npm run occ:provision` and are not
modified, patched or repacked on the way. The application loads them at runtime
as a separate module; nothing from OCCT is compiled into the application bundle.

Both files also carry code from the toolchain that built them, the Emscripten
runtime and LLVM's libc++ among it. That is credited in
[../toolchain/](../toolchain/), because neither belongs to OCCT and neither is
covered by the LGPL below.

## Versions

| | |
| --- | --- |
| npm package | `opencascade.js@1.1.1` |
| OCCT revision | `V7_4_0p1`, commit `33d9a6fa21ca4fa711da7066655aa2ba854545ee` |

opencascade.js is installed with `--no-save` and is not a dependency in
`package.json`, which is why it is documented by hand here instead of appearing
in the generated npm bundle.

## Corresponding source

The corresponding source of the shipped binary is two things together, not
either one alone:

1. **Open CASCADE Technology at revision V7_4_0p1**, commit
   `33d9a6fa21ca4fa711da7066655aa2ba854545ee`:
   <https://git.dev.opencascade.org/gitweb/?p=occt.git;a=commit;h=33d9a6fa21ca4fa711da7066655aa2ba854545ee>,
   also mirrored at <https://github.com/Open-Cascade-SAS/OCCT>
2. **The opencascade.js 1.1.1 build**, which is what turns that tree into the
   WebAssembly served here: <https://github.com/donalffons/opencascade.js>

The second is not optional. opencascade.js patches the OCCT tree before
compiling it, in `make.py`, applying `patches/CMakeLists.txt.patch`,
`patches/OSD_Path.cxx.patch`, `patches/OSD_Process.cxx.patch`,
`patches/Bnd_Box.hxx.patch` and `patches/BRepGProp.hxx.patch`. An unpatched
V7_4_0p1 checkout does not build into the binary distributed here. The complete
corresponding source is that revision together with those patches and the
build definition that applies them.

Oversolved modifies neither. It compiles nothing: it copies the two published
artifacts and serves them.

A recipient may also substitute their own build. The two files are loaded at
runtime from `/occ/` by name, so a replacement pair put in their place is the
kernel the application then runs on, which is the relinking freedom the LGPL
reserves for the user. What a substitute has to present is not arbitrary,
though, and the loader in `src/kernel/occ/loadOccWeb.ts` says what: an
Emscripten-style module that exposes a factory taking `locateFile`, and a
`opencascade.wasm.wasm` beside it. A rebuild of opencascade.js meets that; an
arbitrary OCCT build would need the same shape.

## Licensing, in plain terms

The library is under the LGPL. The application that calls it is not, and is
governed by the repository's LICENSE.md.

What keeps those separate is not the exception. The Open CASCADE exception is
narrow: it covers object code that incorporates material from OCCT header files,
which is the situation of a C++ program that compiled against them, and it asks
in return for the prominent notice at the top of this page. Oversolved is not in
that situation, because it never compiles against OCCT at all. It calls a
runtime module through a JavaScript interface.

What keeps them separate is section 6 of the LGPL: Oversolved is a work that
uses the library, the library is distributed unmodified alongside it under its
own license, and the user can replace it. The notice is given regardless,
because the exception is part of the terms under which OCCT is offered and
honouring its condition costs a sentence.
