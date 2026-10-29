import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

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
} from '../src/plugins/macbook/parse.js';

describe('parseBatteryStatus', () => {
  test('on AC with the charge held back is not charging, not discharging', () => {
    // A charge limit parks the battery on AC below 100%. `isCharging: false`
    // alone would read as "draining", which it is not.
    const text = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1111111)\t80%; AC attached; not charging present: true\n";
    assert.deepEqual(parseBatteryStatus(text), {
      percent: 80,
      source: 'ac',
      state: 'not_charging',
      minutesRemaining: null,
    });
  });

  test('discharging reports the estimate in minutes', () => {
    const text = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1111111)\t64%; discharging; 3:12 remaining present: true\n";
    assert.deepEqual(parseBatteryStatus(text), {
      percent: 64,
      source: 'battery',
      state: 'discharging',
      minutesRemaining: 192,
    });
  });

  test('"(no estimate)" is null rather than zero', () => {
    const text = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1111111)\t64%; discharging; (no estimate) present: true\n";
    assert.equal(parseBatteryStatus(text)?.minutesRemaining, null);
  });

  test('charging', () => {
    const text = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1111111)\t71%; charging; 1:05 remaining present: true\n";
    const status = parseBatteryStatus(text);
    assert.equal(status?.state, 'charging');
    assert.equal(status?.minutesRemaining, 65);
  });

  test('charged', () => {
    const text = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1111111)\t100%; charged; 0:00 remaining present: true\n";
    const status = parseBatteryStatus(text);
    assert.equal(status?.state, 'charged');
    assert.equal(status?.minutesRemaining, null, 'a finished charge has nothing remaining to report');
  });

  test('a machine without a battery yields null', () => {
    assert.equal(parseBatteryStatus("Now drawing from 'AC Power'\n"), null);
  });

  test('an unrecognised state is "unknown", not a guess', () => {
    const text = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1111111)\t50%; something new; present: true\n";
    assert.equal(parseBatteryStatus(text)?.state, 'unknown');
  });
});

describe('parseBatteryDetails', () => {
  // The real dump carries a one-line `BatteryData` blob whose inner keys repeat
  // the top-level names — and, in the real thing, a device serial. An
  // unanchored match picks those up, so the fixture reproduces the shape.
  const dump = [
    '    "BatteryData" = {"MaxCapacity"=999,"CycleCount"=7,"Serial"="NOT-A-REAL-SERIAL","DesignCapacity"=1}',
    '    "CycleCount" = 99',
    '    "MaxCapacity" = 100',
    '    "AppleRawMaxCapacity" = 8343',
    '    "DesignCapacity" = 8579',
    '    "Temperature" = 3043',
  ].join('\n');

  test('reads top-level keys only, never the keys inside the BatteryData blob', () => {
    const details = parseBatteryDetails(dump);
    assert.equal(details.cycleCount, 99);
  });

  test('health is raw max capacity over design capacity, as a whole percent', () => {
    assert.equal(parseBatteryDetails(dump).healthPercent, 97);
  });

  test('temperature is in hundredths of a degree', () => {
    assert.equal(parseBatteryDetails(dump).temperatureC, 30.4);
  });

  test('missing keys come back null', () => {
    assert.deepEqual(parseBatteryDetails(''), { cycleCount: null, healthPercent: null, temperatureC: null });
  });

  test('the output carries no field that could hold the serial', () => {
    assert.deepEqual(Object.keys(parseBatteryDetails(dump)).sort(), ['cycleCount', 'healthPercent', 'temperatureC']);
  });
});

describe('parseThermal', () => {
  test('no recorded warning is not throttled', () => {
    const text = [
      'Note: No thermal warning level has been recorded',
      'Note: No performance warning level has been recorded',
      'Note: No CPU power status has been recorded',
    ].join('\n');
    assert.deepEqual(parseThermal(text), { throttled: false });
  });

  test('a CPU speed limit under 100 is throttled', () => {
    const text = 'CPU_Scheduler_Limit = 100\nCPU_Available_CPUs = 8\nCPU_Speed_Limit = 70\n';
    assert.deepEqual(parseThermal(text), { throttled: true });
  });

  test('a scheduler limit under 100 is throttled', () => {
    assert.deepEqual(parseThermal('CPU_Scheduler_Limit = 50\nCPU_Speed_Limit = 100\n'), { throttled: true });
  });

  test('limits at 100 are not throttled', () => {
    assert.deepEqual(parseThermal('CPU_Scheduler_Limit = 100\nCPU_Speed_Limit = 100\n'), { throttled: false });
  });
});

describe('parseDisk', () => {
  const text = [
    'Filesystem     1024-blocks      Used Available Capacity iused      ifree %iused  Mounted on',
    '/dev/disk3s5     971350180 723723776 209300732    78% 7515302 2093007320    0%   /System/Volumes/Data',
  ].join('\n');

  test('sizes are bytes, not kilobytes', () => {
    const disk = parseDisk(text);
    assert.equal(disk?.totalBytes, 971350180 * 1024);
    assert.equal(disk?.freeBytes, 209300732 * 1024);
  });

  test('used percent comes from what is not free', () => {
    // df's own "Used" column leaves out the other volumes sharing the
    // container, so the free space is the number to trust.
    assert.equal(parseDisk(text)?.usedPercent, 78);
  });

  test('garbage yields null', () => {
    assert.equal(parseDisk('nothing useful'), null);
  });
});

describe('parseSwap', () => {
  test('reads megabytes as bytes', () => {
    const text = 'total = 15360.00M  used = 13924.38M  free = 1435.62M  (encrypted)';
    const swap = parseSwap(text);
    assert.equal(swap?.totalBytes, 15360 * 1024 * 1024);
    assert.equal(swap?.usedBytes, Math.round(13924.38 * 1024 * 1024));
  });

  test('garbage yields null', () => {
    assert.equal(parseSwap(''), null);
  });
});

describe('parseMemoryPressure', () => {
  test('takes the free percentage from the summary line', () => {
    const text = [
      'The system has 51539607552 (3145728 pages with a page size of 16384).',
      '',
      'Pages free: 55749',
      '',
      'System-wide memory free percentage: 74%',
    ].join('\n');
    assert.deepEqual(parseMemoryPressure(text), { freePercent: 74 });
  });

  test('missing summary yields null', () => {
    assert.equal(parseMemoryPressure('The system has 1 pages'), null);
  });
});

describe('parsePressureLevel', () => {
  // The kernel's own levels, which are bit flags: 1, 2 and 4.
  test('1 is normal, 2 is warn, 4 is critical', () => {
    assert.equal(parsePressureLevel('1\n'), 'normal');
    assert.equal(parsePressureLevel('2\n'), 'warn');
    assert.equal(parsePressureLevel('4\n'), 'critical');
  });

  test('a value that is not one of the three is null, not a guess', () => {
    assert.equal(parsePressureLevel('3\n'), null);
    assert.equal(parsePressureLevel('0\n'), null);
    assert.equal(parsePressureLevel(''), null);
    assert.equal(parsePressureLevel('normal'), null);
  });
});

describe('parseCompressedBytes', () => {
  const vmStat = [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                                    55749.',
    'Pages stored in compressor:                  2386547.',
    'Pages occupied by compressor:                 581127.',
    'Swapins:                                   130309072.',
  ].join('\n');

  test('is the RAM the compressor occupies, not the data stored in it', () => {
    // "stored" is the uncompressed size; the memory it costs is "occupied".
    assert.equal(parseCompressedBytes(vmStat), 581127 * 16384);
  });

  test('uses the page size the header states', () => {
    const intel = 'Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages occupied by compressor:   1000.\n';
    assert.equal(parseCompressedBytes(intel), 1000 * 4096);
  });

  test('a missing line or header yields null', () => {
    assert.equal(parseCompressedBytes('Pages free: 1.\n'), null);
    assert.equal(parseCompressedBytes('Pages occupied by compressor: 10.\n'), null);
  });
});

describe('parseSleepPrevented', () => {
  test('a held idle-sleep assertion means sleep is prevented', () => {
    const text = 'Assertion status system-wide:\n   PreventUserIdleSystemSleep    1\n   PreventSystemSleep             0\n';
    assert.equal(parseSleepPrevented(text), true);
  });

  test('a held system-sleep assertion means sleep is prevented', () => {
    assert.equal(parseSleepPrevented('   PreventUserIdleSystemSleep    0\n   PreventSystemSleep             1\n'), true);
  });

  test('nothing held means it can sleep', () => {
    assert.equal(parseSleepPrevented('   PreventUserIdleSystemSleep    0\n   PreventSystemSleep             0\n'), false);
  });

  test('owner names below the summary never affect or leak through the result', () => {
    const text = '   PreventUserIdleSystemSleep    0\nListed by owning process:\n   pid 1(someapp): PreventUserIdleSystemSleep named: "x"\n';
    assert.equal(parseSleepPrevented(text), false);
  });
});

describe('topProcesses', () => {
  const ps = [
    '  2048000 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '  1024000 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)',
    '   512000 /usr/local/bin/node',
    '   256000 /opt/homebrew/bin/node',
    '   128000 /System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent',
  ].join('\n');

  test('sums every process of an app under the outermost .app name', () => {
    const top = topProcesses(ps, 5);
    assert.deepEqual(top[0], { name: 'Google Chrome', residentMB: 3000 });
  });

  test('processes without an app bundle group by executable name', () => {
    const node = topProcesses(ps, 5).find((p) => p.name === 'node');
    assert.deepEqual(node, { name: 'node', residentMB: 750 });
  });

  test('a dotted bundle-style name is not mistaken for an .app', () => {
    // "com.apple.WebKit..." contains the text ".app" followed by "le".
    const names = topProcesses(ps, 5).map((p) => p.name);
    assert.ok(!names.includes('com'), 'no phantom "com" entry');
    assert.ok(names.includes('com.apple.WebKit.WebContent'));
  });

  test('sorted by memory, descending, and cut at the limit', () => {
    const top = topProcesses(ps, 2);
    assert.deepEqual(
      top.map((p) => p.name),
      ['Google Chrome', 'node'],
    );
  });

  test('blank and malformed lines are skipped', () => {
    assert.deepEqual(topProcesses('\n  notanumber /bin/x\n   1024 /bin/y\n', 5), [{ name: 'y', residentMB: 1 }]);
  });

  test('the result holds names and sizes only — never a path or an argument', () => {
    for (const entry of topProcesses(ps, 10)) {
      assert.deepEqual(Object.keys(entry).sort(), ['name', 'residentMB']);
      assert.ok(!entry.name.includes('/'));
    }
  });
});
