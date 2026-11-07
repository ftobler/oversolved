// `--import` entry for the forked watchdog children (solveTimeout,
// chainTimeout) and regen:corpus: the `@/` alias and .ts resolution of
// resolve-alias.loader.mjs, registered in-thread where Node supports it.
import { resolveSync } from '../resolve-alias.loader.mjs'
import { registerLoaderHooks } from './registerLoaderHooks.mjs'

registerLoaderHooks(new URL('../resolve-alias.loader.mjs', import.meta.url).href, { resolve: resolveSync })
