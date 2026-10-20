// Loaded by every vitest fork through --import before vitest's own modules.
// The loader hook rewrites the bundled birpc timeout; see the loader file.
//
// `registerHooks` is the synchronous API on newer Node versions (Node 26
// deprecates `register`); the older async registration stays as the fallback
// for the project's Node 20 floor. Node 22 ships `registerHooks` too, but there
// (seen on 22.17) any sync hook breaks require(esm) inside a CJS module loaded
// through the ESM translators: jsdom's cssstyle dies with "Unexpected module
// status 3" and every jsdom test file fails to load. So 22 and 23 keep the
// async path.
import * as nodeModule from 'node:module'
import { load } from './vitestRpcTimeout.loader.mjs'

const nodeMajor = Number(process.versions.node.split('.')[0])
if (nodeMajor >= 24 && typeof nodeModule.registerHooks === 'function') nodeModule.registerHooks({ load })
else nodeModule.register('./vitestRpcTimeout.loader.mjs', import.meta.url)
