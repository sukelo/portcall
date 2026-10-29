import { execFile } from 'node:child_process';
import { cpus, loadavg, totalmem, uptime } from 'node:os';
import { promisify } from 'node:util';

import { McpServer } from '@modelcontextprotocol/server';

import { inProcess } from '../../adapters/inProcess.js';
import type { Plugin } from '../../types.js';
import { registerTools, type Host } from './tools.js';

const exec = promisify(execFile);

/**
 * A command that has not answered by now is stuck; the status is no use late.
 * `memory_pressure` is the slowest and still finishes well inside this.
 */
const COMMAND_TIMEOUT_MS = 5_000;

export interface MacbookPluginOptions {
  /** Mount segment. Defaults to `macbook`, serving `/macbook/mcp`. */
  path?: string;
  /**
   * Serve `macbook_memory_apps`, which says which apps are running. On by default;
   * a host that would rather not publish that turns it off.
   */
  apps?: boolean;
}

function realHost(): Host {
  return {
    run: async (file, args) => {
      const { stdout } = await exec(file, [...args], {
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        // Not the daemon's environment: it holds the bearer token and the KIS
        // credentials, and a status command has no use for either. The fixed
        // locale keeps the output the parsers expect.
        env: { LC_ALL: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      });
      return stdout;
    },
    chip: () => cpus()[0]?.model ?? 'unknown',
    cores: () => cpus().length,
    loadAverage: () => {
      const [one = 0, five = 0, fifteen = 0] = loadavg();
      return [one, five, fifteen];
    },
    uptimeSeconds: () => uptime(),
    totalMemoryBytes: () => totalmem(),
  };
}

/**
 * Status of the Mac the daemon runs on, served in-process.
 *
 * Read-only: the tools take no command, path or filter from the caller, and
 * everything they run is a fixed list in `tools.ts`. Nothing here needs
 * credentials, so there is nothing to configure to turn it on.
 */
export function macbookPlugin(options: MacbookPluginOptions = {}): Plugin {
  const { path = 'macbook', apps = true } = options;
  const name = `macbook(${path})`;
  const host = realHost();

  return {
    name,
    path,
    handler: inProcess(name, () => {
      const server = new McpServer({ name: 'portcall-macbook', version: '0.1.0' });
      registerTools(server, host, { apps });
      return server;
    }),
  };
}
