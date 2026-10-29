/**
 * Parsers for the text macOS tools print.
 *
 * Each takes the output as a string and returns only the fields the status
 * tools publish. That is deliberate: `ioreg` and `ps` print serial numbers and
 * command lines, and the repository is public, so nothing here passes a
 * parsed record through — a field is named in the return type or it does not
 * leave this file.
 */

export interface BatteryStatus {
  percent: number;
  source: 'ac' | 'battery' | 'unknown';
  /**
   * `not_charging` is AC attached with the charge held back (a charge limit),
   * which is neither charging nor draining.
   */
  state: 'charging' | 'discharging' | 'charged' | 'not_charging' | 'unknown';
  minutesRemaining: number | null;
}

/** `pmset -g batt`. Null on a machine with no battery line. */
export function parseBatteryStatus(text: string): BatteryStatus | null {
  const line = /(\d+)%;\s*(.*?)\s*;?\s+present:/.exec(text);
  if (line === null) return null;

  const source = /Now drawing from 'AC Power'/.test(text)
    ? 'ac'
    : /Now drawing from 'Battery Power'/.test(text)
      ? 'battery'
      : 'unknown';

  const parts = line[2]!
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '' && part !== 'AC attached');

  const word = parts[0] ?? '';
  const state: BatteryStatus['state'] =
    word === 'charging'
      ? 'charging'
      : word === 'discharging'
        ? 'discharging'
        : word === 'charged' || word === 'finishing charge'
          ? 'charged'
          : word === 'not charging'
            ? 'not_charging'
            : 'unknown';

  const estimate = parts.map((part) => /^(\d+):(\d{2}) remaining$/.exec(part)).find((m) => m !== null);
  // "0:00 remaining" is what a finished charge prints; it is not an estimate.
  const minutes = estimate === undefined || estimate === null ? 0 : Number(estimate[1]) * 60 + Number(estimate[2]);

  return {
    percent: Number(line[1]),
    source,
    state,
    minutesRemaining: minutes > 0 ? minutes : null,
  };
}

export interface BatteryDetails {
  cycleCount: number | null;
  healthPercent: number | null;
  temperatureC: number | null;
}

/**
 * A top-level integer property from `ioreg`.
 *
 * Anchored to the start of the line. The dump also holds a one-line
 * `BatteryData` blob that repeats these key names — and a serial number —
 * so an unanchored match reads the wrong value and echoes the blob.
 */
function ioregInt(text: string, key: string): number | null {
  const match = new RegExp(`^[\\s|+-]*"${key}" = (-?\\d+)\\s*$`, 'm').exec(text);
  return match === null ? null : Number(match[1]);
}

/** `ioreg -rn AppleSmartBattery`. */
export function parseBatteryDetails(text: string): BatteryDetails {
  const raw = ioregInt(text, 'AppleRawMaxCapacity');
  const design = ioregInt(text, 'DesignCapacity');
  const temperature = ioregInt(text, 'Temperature');

  return {
    cycleCount: ioregInt(text, 'CycleCount'),
    healthPercent: raw !== null && design !== null && design > 0 ? Math.round((raw / design) * 100) : null,
    // Reported in hundredths of a degree.
    temperatureC: temperature === null ? null : Math.round(temperature / 10) / 10,
  };
}

/** `pmset -g therm`. With nothing recorded it prints only "Note:" lines. */
export function parseThermal(text: string): { throttled: boolean } {
  const limits = [...text.matchAll(/CPU_(?:Speed|Scheduler)_Limit\s*=\s*(\d+)/g)].map((m) => Number(m[1]));
  return { throttled: limits.some((limit) => limit < 100) };
}

export interface Disk {
  totalBytes: number;
  freeBytes: number;
  usedPercent: number;
}

/** `df -k <path>`. */
export function parseDisk(text: string): Disk | null {
  for (const line of text.split('\n')) {
    const match = /^\S+\s+(\d+)\s+\d+\s+(\d+)\s+\d+%/.exec(line.trim());
    if (match === null) continue;

    const totalBytes = Number(match[1]) * 1024;
    const freeBytes = Number(match[2]) * 1024;
    // From what is free, not from df's "Used": on APFS that column leaves out
    // the other volumes sharing the container.
    return { totalBytes, freeBytes, usedPercent: Math.round(((totalBytes - freeBytes) / totalBytes) * 100) };
  }
  return null;
}

/** `sysctl -n vm.swapusage`. */
export function parseSwap(text: string): { totalBytes: number; usedBytes: number } | null {
  const match = /total = ([\d.]+)M\s+used = ([\d.]+)M/.exec(text);
  if (match === null) return null;
  return {
    totalBytes: Math.round(Number(match[1]) * 1024 * 1024),
    usedBytes: Math.round(Number(match[2]) * 1024 * 1024),
  };
}

/** `memory_pressure`. Only the summary line is read. */
export function parseMemoryPressure(text: string): { freePercent: number } | null {
  const match = /System-wide memory free percentage:\s*(\d+)%/.exec(text);
  return match === null ? null : { freePercent: Number(match[1]) };
}

export type PressureLevel = 'normal' | 'warn' | 'critical';

/**
 * `sysctl -n kern.memorystatus_vm_pressure_level`: the kernel's own verdict on
 * memory, the one behind Activity Monitor's green/yellow/red graph. The values
 * are the bit flags 1, 2 and 4; anything else is left unnamed rather than
 * guessed at.
 */
export function parsePressureLevel(text: string): PressureLevel | null {
  switch (text.trim()) {
    case '1':
      return 'normal';
    case '2':
      return 'warn';
    case '4':
      return 'critical';
    default:
      return null;
  }
}

/**
 * `vm_stat`: the RAM the memory compressor occupies. "Stored in compressor"
 * is the size of the data before compression; "occupied" is what it costs,
 * and the page size comes from the header rather than being assumed.
 */
export function parseCompressedBytes(text: string): number | null {
  const pageSize = /page size of (\d+) bytes/.exec(text);
  const pages = /^Pages occupied by compressor:\s+(\d+)\./m.exec(text);
  if (pageSize === null || pages === null) return null;
  return Number(pages[1]) * Number(pageSize[1]);
}

/**
 * `pmset -g assertions`. Reads the two summary counters and nothing else: the
 * rest of the output names the processes holding each assertion, which is a
 * list of what is running.
 */
export function parseSleepPrevented(text: string): boolean {
  const held = [...text.matchAll(/^\s+(?:PreventUserIdleSystemSleep|PreventSystemSleep)\s+(\d+)\s*$/gm)];
  return held.some((m) => Number(m[1]) > 0);
}

export interface ProcessMemory {
  name: string;
  residentMB: number;
}

/**
 * The name a process is reported under: its outermost `.app` bundle, or the
 * executable's own name when there is none.
 *
 * `.app` has to end a path segment. Without that, `com.apple.WebKit...` is
 * read as an app called "com".
 */
function displayName(executable: string): string {
  const bundle = /([^/]+)\.app(?=\/|$)/.exec(executable);
  if (bundle !== null) return bundle[1]!;
  return executable.slice(executable.lastIndexOf('/') + 1);
}

/**
 * `ps -axo rss=,comm=`, summed per app and cut to the biggest.
 *
 * `comm` is the executable path with no arguments — the command line, where
 * a token could sit, is never requested. RSS counts shared pages in every
 * process that maps them, so the totals are an approximation.
 */
export function topProcesses(text: string, limit: number): ProcessMemory[] {
  const kilobytes = new Map<string, number>();

  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (match === null) continue;
    const name = displayName(match[2]!);
    if (name === '') continue;
    kilobytes.set(name, (kilobytes.get(name) ?? 0) + Number(match[1]));
  }

  return [...kilobytes]
    .map(([name, kb]) => ({ name, residentMB: Math.round(kb / 1024) }))
    .sort((a, b) => b.residentMB - a.residentMB || a.name.localeCompare(b.name))
    .slice(0, limit);
}
