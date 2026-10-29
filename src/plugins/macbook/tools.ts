import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import {
  parseBatteryDetails,
  parseBatteryStatus,
  parseCompressedBytes,
  parseDisk,
  parseMemoryPressure,
  parsePressureLevel,
  parseSleepPrevented,
  parseSwap,
  parseThermal,
  topProcesses,
} from './parse.js';

/**
 * Read-only tools over the host the daemon runs on.
 *
 * Everything comes from the fixed commands below, run by absolute path with
 * fixed arguments: no tool takes a command, a path or a filter from the
 * caller, and none can be made to run anything else. `ps` is asked for the
 * executable (`comm`) and never the command line, where a token could sit.
 */
export const COMMANDS = {
  battery: { file: '/usr/bin/pmset', args: ['-g', 'batt'] },
  thermal: { file: '/usr/bin/pmset', args: ['-g', 'therm'] },
  assertions: { file: '/usr/bin/pmset', args: ['-g', 'assertions'] },
  batteryDetails: { file: '/usr/sbin/ioreg', args: ['-rn', 'AppleSmartBattery'] },
  // The Data volume, not `/`: `/` is the sealed system snapshot and says
  // nothing about the space the user has left.
  disk: { file: '/bin/df', args: ['-k', '/System/Volumes/Data'] },
  swap: { file: '/usr/sbin/sysctl', args: ['-n', 'vm.swapusage'] },
  pressure: { file: '/usr/bin/memory_pressure', args: [] },
  pressureLevel: { file: '/usr/sbin/sysctl', args: ['-n', 'kern.memorystatus_vm_pressure_level'] },
  vmStat: { file: '/usr/bin/vm_stat', args: [] },
  processes: { file: '/bin/ps', args: ['-axo', 'rss=,comm='] },
} as const satisfies Record<string, { file: string; args: readonly string[] }>;

/** What the tools read from the machine, so tests can supply it. */
export interface Host {
  /** Run a command and return its stdout. Rejects on failure or timeout. */
  run(file: string, args: readonly string[]): Promise<string>;
  chip(): string;
  cores(): number;
  loadAverage(): readonly [number, number, number];
  uptimeSeconds(): number;
  totalMemoryBytes(): number;
}

export interface MacbookToolOptions {
  /** Register `macbook_memory_apps`. Off, the response never says what is running. Default on. */
  apps?: boolean;
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

const UNAVAILABLE = { error: 'unavailable' } as const;

/**
 * One section of the status, or `{ error }` when its source failed.
 *
 * The cause is not passed on: it is a command's stderr or a parser's
 * complaint, and the caller has no use for either.
 */
async function section<T extends object>(read: () => Promise<T>): Promise<T | typeof UNAVAILABLE> {
  try {
    return await read();
  } catch {
    return UNAVAILABLE;
  }
}

function must<T>(value: T | null): T {
  if (value === null) throw new Error('unparseable');
  return value;
}

function run(host: Host, command: { file: string; args: readonly string[] }): Promise<string> {
  return host.run(command.file, command.args);
}

function round(value: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function result(summary: string, data: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }],
    structuredContent: data,
  };
}

async function readBattery(host: Host) {
  const status = parseBatteryStatus(await run(host, COMMANDS.battery));
  if (status === null) return { present: false };

  // The detail is a bonus: without it the percentage still stands.
  const details = parseBatteryDetails(await run(host, COMMANDS.batteryDetails).catch(() => ''));
  return { ...status, ...details };
}

async function readMemory(host: Host) {
  const [pressure, swap, level, compressedBytes] = await Promise.all([
    run(host, COMMANDS.pressure).then((text) => must(parseMemoryPressure(text))),
    run(host, COMMANDS.swap).then((text) => must(parseSwap(text))),
    // Extras on top of the free percentage and swap: losing either leaves the
    // rest of the section standing.
    run(host, COMMANDS.pressureLevel).then(parsePressureLevel).catch(() => null),
    run(host, COMMANDS.vmStat).then(parseCompressedBytes).catch(() => null),
  ]);
  return {
    totalBytes: host.totalMemoryBytes(),
    freePercent: pressure.freePercent,
    pressureLevel: level,
    compressedBytes,
    swapUsedBytes: swap.usedBytes,
    swapTotalBytes: swap.totalBytes,
  };
}

async function readSystem(host: Host) {
  const [one, five, fifteen] = host.loadAverage();
  const sleepPrevented = await run(host, COMMANDS.assertions)
    .then(parseSleepPrevented)
    .catch(() => null);
  return {
    chip: host.chip(),
    cores: host.cores(),
    loadAverage: { '1m': round(one, 2), '5m': round(five, 2), '15m': round(fifteen, 2) },
    uptimeSeconds: Math.round(host.uptimeSeconds()),
    sleepPrevented,
  };
}

/** A field of a section for the one-line summary; the sections are typed by what they hold, not by index. */
function field(section: object, key: string): string {
  return String((section as Record<string, unknown>)[key]);
}

function describeBattery(battery: object): string {
  if ('error' in battery) return 'battery unavailable';
  if ('present' in battery) return 'no battery';
  return `battery ${field(battery, 'percent')}% (${field(battery, 'source')}, ${field(battery, 'state')})`;
}

function describeFree(memory: object): string {
  return 'error' in memory ? 'memory unavailable' : `memory ${field(memory, 'freePercent')}% free`;
}

function describeDisk(disk: object): string {
  return 'error' in disk ? 'disk unavailable' : `disk ${field(disk, 'usedPercent')}% used`;
}

export function registerTools(server: McpServer, host: Host, options: MacbookToolOptions = {}): void {
  const { apps: withApps = true } = options;

  server.registerTool(
    'macbook_status',
    {
      title: 'MacBook status',
      description:
        'Current state of the MacBook this server runs on: battery (percent, power source, charge state, cycle count, health, temperature), thermal throttling, memory (pressure level, free percentage, RAM held by the compressor, plus swap), disk space on the data volume, chip, load average, uptime, and whether sleep is being prevented. Sizes are bytes, durations are seconds, temperature is °C. `battery.state` of `not_charging` means AC is attached but the charge is being held back. `memory.pressureLevel` (`normal`, `warn`, `critical`) is the kernel verdict on memory — the measure to judge by, since swap can stay large long after the pressure has passed. A section that could not be read is `{ "error": "unavailable" }`. This answers only while the Mac is awake and running the server.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () => {
      const [battery, thermal, memory, disk, system] = await Promise.all([
        section(() => readBattery(host)),
        section(async () => parseThermal(await run(host, COMMANDS.thermal))),
        section(() => readMemory(host)),
        section(async () => must(parseDisk(await run(host, COMMANDS.disk)))),
        section(() => readSystem(host)),
      ]);
      const data = { battery, thermal, memory, disk, system };
      return result(`${describeBattery(battery)} · ${describeFree(memory)} · ${describeDisk(disk)}`, data);
    },
  );

  if (!withApps) return;

  server.registerTool(
    'macbook_memory_apps',
    {
      title: 'Top memory apps',
      description:
        'The apps using the most memory right now, by name and resident size in MB. Processes are grouped under their app (all of Chrome\'s helpers count as "Google Chrome"); anything without an app bundle is grouped by executable name, so unrelated programs of the same name are summed together. Resident size counts shared pages once per process, so totals are approximate. Names and sizes only — no paths, no arguments.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(10).default(5).describe('How many apps to return (1–10, default 5)'),
      }),
      annotations: READ_ONLY,
    },
    async ({ limit }) => {
      const apps = topProcesses(await run(host, COMMANDS.processes), limit);
      const summary = apps.map((app) => `${app.name} ${app.residentMB} MB`).join(', ');
      return result(summary === '' ? 'No processes read' : summary, { apps });
    },
  );
}
