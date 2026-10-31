// A user error raised by a tool op: a body id the build does not have, an input
// file outside the read roots, a path that does not exist. The MCP server
// answers it as a tool failure (`ok: false` with the message and the MCP
// isError flag), never as a JSON-RPC internal error, which is reserved for a
// bug in the server itself. Kept in its own module so the path helpers and the
// protocol module share one class without importing each other.

export class McpToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpToolError'
  }
}
