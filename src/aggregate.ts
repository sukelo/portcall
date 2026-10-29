import { McpServer, Server } from '@modelcontextprotocol/server';
import type { CallToolResult, ListToolsResult, McpRequestContext, McpServerFactory, Tool } from '@modelcontextprotocol/server';

import { inProcess } from './adapters/inProcess.js';
import { openUpstream } from './adapters/upstream.js';
import type { Upstream } from './adapters/upstream.js';
import { log } from './log.js';
import type { Plugin } from './types.js';

/**
 * One MCP server presenting every plugin's tools behind a single URL.
 *
 * A connector is one URL, so without this each plugin is a separate
 * registration, each with its own copy of the credential. The listing is the
 * plugins' listings concatenated and a call goes to whichever plugin owns the
 * name — the same approach the vault uses to fold its own tools into
 * mcpvault's, one level up.
 *
 * Tools only. The plugins here serve nothing else; a plugin that grows
 * resources or prompts needs this to forward them before it can be mounted
 * through the root.
 *
 * Tool names are global at this level. When two plugins claim one name the
 * first in the plugin list keeps it and the other is dropped from the listing,
 * with an error in the log. Refusing to start would be stricter, but the
 * daemon restarts itself, so a refusal would turn one clash into a restart
 * loop that takes every mount down.
 */
export function aggregateTools(
  plugins: readonly Plugin[],
  serverInfo: { name: string; version: string },
): McpServerFactory {
  /**
   * Which plugin owns a tool name.
   *
   * Shared across requests: the factory runs once per request, and the tool
   * sets do not change while the process is up. It spares a call from building
   * every plugin's server just to find out which one it needs.
   */
  const owners = new Map<string, Plugin>();
  const reported = new Set<string>();

  /** Record ownership of what a plugin listed, and return the part it kept. */
  function claim(plugin: Plugin, tools: Tool[]): Tool[] {
    const kept: Tool[] = [];
    for (const tool of tools) {
      const owner = owners.get(tool.name);
      if (owner !== undefined && owner !== plugin) {
        if (!reported.has(tool.name)) {
          reported.add(tool.name);
          log.error('duplicate tool name at the root mount', {
            tool: tool.name,
            kept: owner.name,
            dropped: plugin.name,
          });
        }
        continue;
      }
      owners.set(tool.name, plugin);
      kept.push(tool);
    }
    return kept;
  }

  return (ctx: McpRequestContext): Server => {
    const server = new Server(serverInfo, { capabilities: { tools: {} } });
    const links = new Map<Plugin, Promise<Upstream>>();

    /** Plugins are connected on first use, so a call only builds the one it needs. */
    function connect(plugin: Plugin): Promise<Upstream> {
      let link = links.get(plugin);
      if (link === undefined) {
        link = (async () => {
          const built = await plugin.factory(ctx);
          return openUpstream(built instanceof McpServer ? built.server : built, `The ${plugin.name} server`);
        })();
        links.set(plugin, link);
      }
      return link;
    }

    async function listAll(): Promise<Tool[]> {
      // One plugin failing to answer must not hide the rest.
      const settled = await Promise.allSettled(
        plugins.map(async (plugin) => {
          const listed = await (await connect(plugin)).call('tools/list', {});
          return claim(plugin, Array.isArray(listed['tools']) ? (listed['tools'] as Tool[]) : []);
        }),
      );

      const tools: Tool[] = [];
      settled.forEach((outcome, index) => {
        if (outcome.status === 'fulfilled') tools.push(...outcome.value);
        else {
          log.error('plugin could not list its tools at the root mount', {
            plugin: plugins[index]?.name,
            error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
          });
        }
      });
      return tools;
    }

    server.setRequestHandler('tools/list', async (): Promise<ListToolsResult> => ({ tools: await listAll() }));

    server.setRequestHandler('tools/call', async (request): Promise<CallToolResult> => {
      const { name } = request.params;
      let owner = owners.get(name);
      if (owner === undefined) {
        // First sight of this name since the process started.
        await listAll();
        owner = owners.get(name);
      }
      if (owner === undefined) throw new Error(`Unknown tool: ${name}`);

      const forwarded = await (await connect(owner)).call('tools/call', { ...request.params });
      return forwarded as CallToolResult;
    });

    server.onclose = () => {
      for (const link of links.values()) void link.then((upstream) => upstream.close()).catch(() => undefined);
    };

    return server;
  };
}

/** The plugin served at the prefix root: everything mounted, behind one URL. */
export function aggregatePlugin(plugins: readonly Plugin[]): Plugin {
  const name = 'portcall(all)';
  const factory = aggregateTools(plugins, { name: 'portcall', version: '0.1.0' });
  // `path` is never used to mount this: the root mount is placed by `resolveMounts`.
  return { name, path: '*', handler: inProcess(name, factory), factory };
}
