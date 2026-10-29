import type { McpHttpHandler, McpServerFactory } from '@modelcontextprotocol/server';

/**
 * A mounted MCP server.
 *
 * `path` is the mount segment, not a full URL: a plugin with `path: 'vault'`
 * is served at `/vault/mcp`.
 */
export interface Plugin {
  /** Display name, used in logs and the health endpoint. */
  name: string;
  /** Mount segment. Must not contain slashes. */
  path: string;
  /** The web-standard MCP handler serving this mount. */
  handler: McpHttpHandler;
  /**
   * The factory `handler` was built from.
   *
   * Kept so the root mount can put this plugin's tools behind a server of its
   * own; it is the same factory, so a tool means the same thing at either URL.
   */
  factory: McpServerFactory;
}
