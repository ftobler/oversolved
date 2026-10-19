// Loaded by every vitest fork through --import before vitest's own modules.
// The loader hook rewrites the bundled birpc timeout; see the loader file.
//
// `registerHooks` is the synchronous API on newer Node versions (Node 26
// deprecates `register`); the older async registration stays as the fallback
// for the project's Node 20 floor.
import * as nodeModule from 'node:module'
import { load } from './vitestRpcTimeout.loader.mjs'

if (typeof nodeModule.registerHooks === 'function') nodeModule.registerHooks({ load })
else nodeModule.register('./vitestRpcTimeout.loader.mjs', import.meta.url)
