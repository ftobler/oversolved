// `--import` entry for the headless drive surfaces (the CLI, the MCP server
// and the regressions script): the alias resolver plus the import.meta.env
// shim of driveCli.loader.mjs, registered in-thread where Node supports it.
import { resolveSync, loadSync } from './driveCli.loader.mjs'
import { registerLoaderHooks } from './registerLoaderHooks.mjs'

registerLoaderHooks(new URL('./driveCli.loader.mjs', import.meta.url).href, { resolve: resolveSync, load: loadSync })
