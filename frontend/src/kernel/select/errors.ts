// A selector failure: an invalid expression (unknown predicate key, bad axis)
// or a match that came up empty with its nearest-miss diagnostics. The MCP
// `select` tool surfaces the message as `{ ok: false, error }`; the structural
// argument checks in drive/mcpServer.ts turn an invalid expression into an
// invalid-params protocol error instead.

export class SelectorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SelectorError'
  }
}
