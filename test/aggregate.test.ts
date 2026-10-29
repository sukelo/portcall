import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { McpServer } from '@modelcontextprotocol/server';
import type { McpRequestContext } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { openUpstream } from '../src/adapters/upstream.js';
import { aggregateTools } from '../src/aggregate.js';
import type { Plugin } from '../src/types.js';

/** A plugin whose tools each answer with their own name, so routing is visible. */
function fake(name: string, tools: string[], build?: () => McpServer): Plugin {
  const factory = () => {
    if (build !== undefined) return build();
    const server = new McpServer({ name, version: '0' });
    for (const tool of tools) {
      server.registerTool(
        tool,
        { description: `${name}:${tool}`, inputSchema: z.object({}) },
        async () => ({ content: [{ type: 'text' as const, text: `${name}/${tool}` }] }),
      );
    }
    return server;
  };
  return { name, path: name, handler: {} as Plugin['handler'], factory };
}

/** Talk to the aggregate the way a request would: a fresh server each time. */
async function open(plugins: Plugin[]) {
  const factory = aggregateTools(plugins, { name: 'test', version: '0' });
  return {
    connect: async () => openUpstream(await factory({} as McpRequestContext) as never, 'The aggregate'),
  };
}

const namesOf = (listed: Record<string, unknown>) =>
  (listed.tools as { name: string }[]).map((tool) => tool.name).sort();

describe('aggregateTools', () => {
  test('lists every plugin\'s tools together', async () => {
    const { connect } = await open([fake('a', ['a_one', 'a_two']), fake('b', ['b_one'])]);
    const link = await connect();
    try {
      assert.deepEqual(namesOf(await link.call('tools/list', {})), ['a_one', 'a_two', 'b_one']);
    } finally {
      await link.close();
    }
  });

  test('a call reaches the plugin that owns the name', async () => {
    const { connect } = await open([fake('a', ['a_one']), fake('b', ['b_one'])]);

    // Two separate requests: the second one finds the owner cached.
    for (const [tool, expected] of [['b_one', 'b/b_one'], ['a_one', 'a/a_one'], ['b_one', 'b/b_one']] as const) {
      const link = await connect();
      try {
        const result = (await link.call('tools/call', { name: tool, arguments: {} })) as {
          content: { text: string }[];
        };
        assert.equal(result.content[0]?.text, expected);
      } finally {
        await link.close();
      }
    }
  });

  test('a name nobody owns is an error, not a silent empty result', async () => {
    const { connect } = await open([fake('a', ['a_one'])]);
    const link = await connect();
    try {
      await assert.rejects(link.call('tools/call', { name: 'nope', arguments: {} }), /Unknown tool: nope/);
    } finally {
      await link.close();
    }
  });

  test('when two plugins claim a name the first keeps it and the second is dropped', async () => {
    const { connect } = await open([fake('first', ['shared', 'first_only']), fake('second', ['shared', 'second_only'])]);
    const link = await connect();
    try {
      const listed = await link.call('tools/list', {});
      assert.deepEqual(namesOf(listed), ['first_only', 'second_only', 'shared']);

      const result = (await link.call('tools/call', { name: 'shared', arguments: {} })) as {
        content: { text: string }[];
      };
      assert.equal(result.content[0]?.text, 'first/shared');
    } finally {
      await link.close();
    }
  });

  test('a plugin that cannot be built does not hide the others', async () => {
    const broken = fake('broken', [], () => {
      throw new Error('boom');
    });
    const { connect } = await open([broken, fake('b', ['b_one'])]);
    const link = await connect();
    try {
      assert.deepEqual(namesOf(await link.call('tools/list', {})), ['b_one']);
    } finally {
      await link.close();
    }
  });
});
