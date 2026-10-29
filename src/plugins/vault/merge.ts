import { Server } from '@modelcontextprotocol/server';
import type { CallToolResult, ListToolsResult, Tool } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { openUpstream } from '../../adapters/upstream.js';
import type { Upstream } from '../../adapters/upstream.js';

export type ToolResult = CallToolResult;

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** A tool this project adds alongside the ones an upstream server already serves. */
export interface ExtraTool<Args = never> {
  name: string;
  title: string;
  description: string;
  schema: z.ZodType<Args>;
  annotations: ToolAnnotations;
  run: (args: Args) => Promise<ToolResult>;
}

/** A schema failure reads as prose, not as the issue array behind it. */
function explain(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => (issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`))
      .join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

function describe(tool: ExtraTool<never>): Tool {
  const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(tool.schema, { io: 'input' }) as Record<string, unknown>;
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: inputSchema as Tool['inputSchema'],
    annotations: tool.annotations,
  };
}

/**
 * One MCP server presenting an upstream server's tools plus a few of our own.
 *
 * The upstream server registers `tools/list` and `tools/call` directly on a
 * low-level `Server`, so there is no seam to register extra tools into. This
 * fronts it instead: the listing is concatenated and a call goes to whichever
 * side owns the name, which keeps everything on one mount and one connector.
 */
export function mergeTools(
  buildUpstream: () => Server,
  extras: readonly ExtraTool<never>[],
  serverInfo: { name: string; version: string },
): Server {
  const server = new Server(serverInfo, { capabilities: { tools: {} } });
  const owned = new Map(extras.map((tool) => [tool.name, tool]));
  let upstream: Promise<Upstream> | undefined;
  const connect = (): Promise<Upstream> => (upstream ??= openUpstream(buildUpstream(), 'The vault server'));

  server.setRequestHandler('tools/list', async (): Promise<ListToolsResult> => {
    const listed = await (await connect()).call('tools/list', {});
    const inherited = Array.isArray(listed['tools']) ? (listed['tools'] as Tool[]) : [];
    return { tools: [...inherited, ...extras.map(describe)] };
  });

  server.setRequestHandler('tools/call', async (request): Promise<CallToolResult> => {
    const tool = owned.get(request.params.name);
    if (tool === undefined) {
      const forwarded = await (await connect()).call('tools/call', { ...request.params });
      return forwarded as CallToolResult;
    }

    try {
      return await tool.run(tool.schema.parse(request.params.arguments ?? {}) as never);
    } catch (error) {
      // An invalid argument or a missing file is the caller's to fix, so it
      // comes back as tool output rather than a protocol error.
      return { content: [{ type: 'text', text: `Error: ${explain(error)}` }], isError: true };
    }
  });

  server.onclose = () => {
    void upstream?.then((link) => link.close()).catch(() => undefined);
  };

  return server;
}
