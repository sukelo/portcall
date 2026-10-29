import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { JSONRPCMessage, Server } from '@modelcontextprotocol/server';

export interface Upstream {
  call: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  close: () => Promise<void>;
}

interface JsonRpcResponse {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/**
 * How long one upstream call may wait.
 *
 * The server is an object in this process, so a call that has not answered by
 * now is not slow — it is never going to answer, and the HTTP request behind
 * it would hang for as long as the client will hold the connection.
 */
const UPSTREAM_TIMEOUT_MS = 60_000;

/**
 * Speak to a server in this process over a linked transport pair.
 *
 * The SDK publishes a client package, but the only thing needed here is two
 * request methods against an object already in memory, so the handshake and
 * id matching are done directly rather than pulling in a second dependency.
 *
 * Every way a call can fail has to end in a rejection. `send` throws once the
 * transport is closed, and a discarded rejection is fatal under Node's default
 * `--unhandled-rejections=throw`: the daemon would exit because one client
 * disconnected mid-request.
 */
export async function openUpstream(server: Server, label = 'The upstream server'): Promise<Upstream> {
  const [near, far] = InMemoryTransport.createLinkedPair();

  interface Waiter {
    resolve: (message: JsonRpcResponse) => void;
    reject: (error: Error) => void;
  }
  const pending = new Map<number, Waiter>();
  let nextId = 0;
  let broken: Error | undefined;

  /** Fail every outstanding call, and every later one, with the same cause. */
  function abandon(error: Error): void {
    broken ??= error;
    for (const [id, waiter] of [...pending]) {
      pending.delete(id);
      waiter.reject(error);
    }
  }

  near.onmessage = (message: unknown) => {
    const response = message as JsonRpcResponse;
    if (response.id === undefined) return;
    const waiter = pending.get(response.id);
    if (waiter === undefined) return;
    pending.delete(response.id);
    waiter.resolve(response);
  };
  near.onclose = () => abandon(new Error(`${label} closed the connection before answering.`));
  near.onerror = (error: unknown) => abandon(error instanceof Error ? error : new Error(String(error)));

  await server.connect(far);
  await near.start();

  async function call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (broken !== undefined) throw broken;

    const id = (nextId += 1);
    const response = await new Promise<JsonRpcResponse>((resolve, reject) => {
      const deadline = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${label} did not answer ${method} within ${UPSTREAM_TIMEOUT_MS}ms.`));
      }, UPSTREAM_TIMEOUT_MS);
      deadline.unref();

      const settle: Waiter = {
        resolve: (message) => {
          clearTimeout(deadline);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(deadline);
          reject(error);
        },
      };
      pending.set(id, settle);

      near.send({ jsonrpc: '2.0', id, method, params } as JSONRPCMessage).catch((error: unknown) => {
        pending.delete(id);
        settle.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });

    if (response.error !== undefined) throw new Error(response.error.message);
    return response.result ?? {};
  }

  try {
    await call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'portcall', version: '0.1.0' },
    });
    await near.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);
  } catch (error) {
    // A half-open pair would otherwise sit there holding the upstream server.
    await near.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    throw error;
  }

  return {
    call,
    close: async () => {
      abandon(new Error(`${label} was closed while a call was in flight.`));
      await near.close();
      await server.close();
    },
  };
}
