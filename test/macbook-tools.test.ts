import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';

import { COMMANDS, registerTools, type Host } from '../src/plugins/macbook/tools.js';

const OUTPUT: Record<string, string> = {
  '/usr/bin/pmset -g batt':
    "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1111111)\t80%; AC attached; not charging present: true\n",
  '/usr/bin/pmset -g therm': 'Note: No thermal warning level has been recorded\n',
  '/usr/bin/pmset -g assertions': '   PreventUserIdleSystemSleep     1\n   PreventSystemSleep             0\n',
  // The blob stands in for the real dump's one-line `BatteryData`, which holds a serial.
  '/usr/sbin/ioreg -rn AppleSmartBattery': [
    '    "BatteryData" = {"Serial"="NOT-A-REAL-SERIAL","CycleCount"=7}',
    '    "CycleCount" = 99',
    '    "AppleRawMaxCapacity" = 8343',
    '    "DesignCapacity" = 8579',
    '    "Temperature" = 3043',
  ].join('\n'),
  '/bin/df -k /System/Volumes/Data':
    'Filesystem     1024-blocks      Used Available Capacity iused      ifree %iused  Mounted on\n/dev/disk3s5     971350180 723723776 209300732    78% 7515302 2093007320    0%   /System/Volumes/Data\n',
  '/usr/sbin/sysctl -n vm.swapusage': 'total = 15360.00M  used = 13924.38M  free = 1435.62M  (encrypted)\n',
  '/usr/bin/memory_pressure': 'System-wide memory free percentage: 74%\n',
  '/usr/sbin/sysctl -n kern.memorystatus_vm_pressure_level': '1\n',
  '/usr/bin/vm_stat':
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages occupied by compressor:                 581127.\n',
  '/bin/ps -axo rss=,comm=': [
    '  2048000 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '   512000 /usr/local/bin/node',
    '   256000 /bin/zsh',
  ].join('\n'),
};

interface Overrides {
  fail?: string[];
  output?: Record<string, string>;
}

function fakeHost(overrides: Overrides = {}) {
  const ran: string[] = [];
  const host: Host = {
    run: async (file, args) => {
      const key = [file, ...args].join(' ');
      ran.push(key);
      if (overrides.fail?.includes(key)) throw new Error(`boom: ${key}`);
      const text = overrides.output?.[key] ?? OUTPUT[key];
      if (text === undefined) throw new Error(`unexpected command: ${key}`);
      return text;
    },
    chip: () => 'Apple M3 Max',
    cores: () => 16,
    loadAverage: () => [2.5, 3, 3.5],
    uptimeSeconds: () => 3_600_000,
    totalMemoryBytes: () => 51_539_607_552,
  };
  return { host, ran };
}

async function openTools(overrides: Overrides = {}, options: { apps?: boolean } = {}) {
  const { host, ran } = fakeHost(overrides);
  const server = new McpServer({ name: 'macbook-test', version: '0' });
  registerTools(server, host, options);

  const [near, far] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (message: Record<string, any>) => void>();
  near.onmessage = (message: any) => {
    const settle = pending.get(message.id);
    if (settle !== undefined) {
      pending.delete(message.id);
      settle(message);
    }
  };
  await server.connect(far);
  await near.start();

  let id = 0;
  const rpc = (method: string, params: Record<string, unknown>): Promise<Record<string, any>> =>
    new Promise((resolve) => {
      id += 1;
      pending.set(id, resolve);
      void near.send({ jsonrpc: '2.0', id, method, params } as any);
    });

  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  await near.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as any);

  return {
    ran,
    listed: async () => (await rpc('tools/list', {}))['result'].tools as Record<string, any>[],
    call: async (name: string, args: Record<string, unknown> = {}) => rpc('tools/call', { name, arguments: args }),
    close: async () => {
      await near.close();
      await server.close();
    },
  };
}

describe('macbook tools: registration', () => {
  test('exactly two tools, both read-only', async () => {
    const tools = await openTools();
    try {
      const listed = await tools.listed();
      assert.deepEqual(listed.map((t) => t['name']).sort(), ['macbook_memory_apps', 'macbook_status']);
      for (const tool of listed) assert.equal(tool['annotations']?.readOnlyHint, true);
    } finally {
      await tools.close();
    }
  });

  test('with apps switched off, the app list is not registered at all', async () => {
    // The point of a separate tool: what is running is switchable on its own.
    const tools = await openTools({}, { apps: false });
    try {
      assert.deepEqual((await tools.listed()).map((t) => t['name']), ['macbook_status']);
    } finally {
      await tools.close();
    }
  });
});

describe('macbook_status', () => {
  test('assembles every section from the sources', async () => {
    const tools = await openTools();
    try {
      const data = (await tools.call('macbook_status'))['result'].structuredContent;

      assert.deepEqual(data.battery, {
        percent: 80,
        source: 'ac',
        state: 'not_charging',
        minutesRemaining: null,
        cycleCount: 99,
        healthPercent: 97,
        temperatureC: 30.4,
      });
      assert.deepEqual(data.thermal, { throttled: false });
      assert.deepEqual(data.memory, {
        totalBytes: 51_539_607_552,
        freePercent: 74,
        pressureLevel: 'normal',
        compressedBytes: 581127 * 16384,
        swapUsedBytes: Math.round(13924.38 * 1024 * 1024),
        swapTotalBytes: 15360 * 1024 * 1024,
      });
      assert.deepEqual(data.disk, {
        totalBytes: 971350180 * 1024,
        freeBytes: 209300732 * 1024,
        usedPercent: 78,
      });
      assert.deepEqual(data.system, {
        chip: 'Apple M3 Max',
        cores: 16,
        loadAverage: { '1m': 2.5, '5m': 3, '15m': 3.5 },
        uptimeSeconds: 3_600_000,
        sleepPrevented: true,
      });
    } finally {
      await tools.close();
    }
  });

  test('losing the pressure level or compressed size leaves the rest of memory intact', async () => {
    // Both are extras on top of the free percentage and swap; neither is worth
    // failing the whole section over.
    const tools = await openTools({
      fail: ['/usr/sbin/sysctl -n kern.memorystatus_vm_pressure_level', '/usr/bin/vm_stat'],
    });
    try {
      const data = (await tools.call('macbook_status'))['result'].structuredContent;
      assert.equal(data.memory.pressureLevel, null);
      assert.equal(data.memory.compressedBytes, null);
      assert.equal(data.memory.freePercent, 74);
      assert.equal(data.memory.swapUsedBytes, Math.round(13924.38 * 1024 * 1024));
    } finally {
      await tools.close();
    }
  });

  test('reports the MacBook and nothing about the daemon', async () => {
    // The daemon's own uptime belongs to /healthz, not to a mount named for the machine.
    const tools = await openTools();
    try {
      const data = (await tools.call('macbook_status'))['result'].structuredContent;
      assert.deepEqual(Object.keys(data).sort(), ['battery', 'disk', 'memory', 'system', 'thermal']);
    } finally {
      await tools.close();
    }
  });

  test('one failing source marks only its own section', async () => {
    const tools = await openTools({ fail: ['/usr/bin/memory_pressure'] });
    try {
      const data = (await tools.call('macbook_status'))['result'].structuredContent;
      assert.deepEqual(data.memory, { error: 'unavailable' });
      assert.equal(data.battery.percent, 80);
      assert.equal(data.disk.usedPercent, 78);
    } finally {
      await tools.close();
    }
  });

  test('a failure does not echo the error text', async () => {
    const tools = await openTools({ fail: ['/bin/df -k /System/Volumes/Data'] });
    try {
      const text = JSON.stringify((await tools.call('macbook_status'))['result']);
      assert.ok(!text.includes('boom'), 'the underlying message stays out of the response');
    } finally {
      await tools.close();
    }
  });

  test('a machine without a battery says so instead of failing', async () => {
    const tools = await openTools({ output: { '/usr/bin/pmset -g batt': "Now drawing from 'AC Power'\n" } });
    try {
      const data = (await tools.call('macbook_status'))['result'].structuredContent;
      assert.deepEqual(data.battery, { present: false });
    } finally {
      await tools.close();
    }
  });

  test('the response never carries the battery serial or any process path', async () => {
    const tools = await openTools();
    try {
      const text = JSON.stringify((await tools.call('macbook_status'))['result']);
      assert.ok(!text.includes('NOT-A-REAL-SERIAL'));
      assert.ok(!text.includes('/Applications'));
    } finally {
      await tools.close();
    }
  });

  test('does not list processes — that is the other tool', async () => {
    const tools = await openTools();
    try {
      await tools.call('macbook_status');
      assert.ok(!tools.ran.some((command) => command.startsWith('/bin/ps')));
    } finally {
      await tools.close();
    }
  });
});

describe('macbook_memory_apps', () => {
  test('returns the biggest apps by name and size', async () => {
    const tools = await openTools();
    try {
      const data = (await tools.call('macbook_memory_apps'))['result'].structuredContent;
      assert.deepEqual(data.apps, [
        { name: 'Google Chrome', residentMB: 2000 },
        { name: 'node', residentMB: 500 },
        { name: 'zsh', residentMB: 250 },
      ]);
    } finally {
      await tools.close();
    }
  });

  test('defaults to five and caps the limit at ten', async () => {
    const tools = await openTools();
    try {
      const over = await tools.call('macbook_memory_apps', { limit: 11 });
      assert.ok(over['error'] !== undefined || over['result']?.isError === true, 'eleven is rejected');
      const ok = await tools.call('macbook_memory_apps', { limit: 1 });
      assert.equal(ok['result'].structuredContent.apps.length, 1);
    } finally {
      await tools.close();
    }
  });

  test('asks ps for resident size and executable only, never the arguments', async () => {
    const tools = await openTools();
    try {
      await tools.call('macbook_memory_apps');
      const ps = tools.ran.filter((command) => command.startsWith('/bin/ps'));
      assert.deepEqual(ps, ['/bin/ps -axo rss=,comm=']);
    } finally {
      await tools.close();
    }
  });
});

describe('macbook plugin: what it may run', () => {
  test('every command is a fixed absolute path', () => {
    for (const command of Object.values(COMMANDS)) {
      assert.ok(command.file.startsWith('/'), `${command.file} is absolute`);
    }
  });

  test('nothing run during a full pass falls outside the fixed list', async () => {
    const tools = await openTools();
    try {
      await tools.call('macbook_status');
      await tools.call('macbook_memory_apps');
      const allowed = new Set(Object.values(COMMANDS).map((c) => [c.file, ...c.args].join(' ')));
      for (const command of tools.ran) assert.ok(allowed.has(command), `${command} is on the list`);
    } finally {
      await tools.close();
    }
  });
});
