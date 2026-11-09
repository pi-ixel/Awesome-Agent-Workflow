import { createOwnedSession } from "../helpers/ownedSession.ts";
import { appLogSink } from "../../src/shared/diagnosticEvents/logger.ts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseElicitationForm } from "../../src/shared/acp/elicitation.ts";
import {
  validateForm,
  fieldOptions,
  type ElicitationForm,
} from "../../src/contracts/elicitation.ts";
import { createElicitationQueue } from "../../src/plugins/project/interactions/elicitationStore.ts";
import { JsonRpcConnection } from "../../src/plugins/acpConnection/protocol/JsonRpcConnection.ts";
import { createTransportPair } from "../../src/plugins/acpConnection/protocol/transport/inMemoryTransport.ts";

const form: ElicitationForm = {
  message: "填写配置",
  sessionId: "s1",
  requestedSchema: {
    properties: {
      name: { type: "string", minLength: 2, pattern: "^[a-z]+$" },
      count: { type: "integer", minimum: 1, maximum: 5 },
      enabled: { type: "boolean" },
      tags: {
        type: "array",
        items: {
          anyOf: [
            { const: "a", title: "选项 A" },
            { const: "b", title: "b" },
          ],
        },
        minItems: 1,
        maxItems: 1,
      },
    },
    required: ["name", "count", "enabled", "tags"],
  },
};

it("pauses parent request timeout while the user fills a form", async () => {
  vi.useFakeTimers();
  try {
    const { client, peer } = createTransportPair();
    const connection = new JsonRpcConnection(client, { requestTimeoutMs: 20 });
    let finish!: (value: unknown) => void;
    let requestId: number;
    connection.setServerRequestHandler(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    peer.onLine((line) => {
      const message = JSON.parse(line) as { id: number; method?: string };
      if (message.method === "initialize") {
        requestId = message.id;
        peer.writeLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "form",
            method: "elicitation/create",
            params: { requestId },
          }),
        );
      }
    });
    const initialized = connection.request("initialize");
    await vi.advanceTimersByTimeAsync(1000);
    expect(connection.requestScope(requestId!)?.signal.aborted).toBe(false);
    finish({ action: "cancel" });
    peer.writeLine(
      JSON.stringify({ jsonrpc: "2.0", id: requestId!, result: {} }),
    );
    await expect(initialized).resolves.toEqual({});
  } finally {
    vi.useRealTimers();
  }
});

it("normalizes omitted schema defaults and refuses unknown fields", () => {
  expect(
    parseElicitationForm({
      mode: "form",
      message: "x",
      requestId: 1,
      requestedSchema: {},
    })?.requestedSchema.properties,
  ).toEqual({});
  expect(
    validateForm(
      {
        message: "x",
        requestedSchema: { properties: { future: { type: "object" } } },
      },
      {},
    ).errors.future,
  ).toBeTruthy();
});
let forms: ReturnType<typeof createElicitationQueue>;
beforeEach(() => { forms = createElicitationQueue(); });
afterEach(() => forms.dispose());

it("validates the SDK form shape and typed fields without converting false to missing", () => {
  expect(
    parseElicitationForm({
      ...form,
      mode: "form",
      requestedSchema: { ...form.requestedSchema, type: "object" },
    }),
  ).not.toBeNull();
  expect(parseElicitationForm({ mode: "url", message: "x" })).toBeNull();
  const result = validateForm(form, {
    name: "ab",
    count: "3",
    enabled: false,
    tags: ["a"],
  });
  expect(result.errors).toEqual({});
  expect(result.content).toEqual({
    name: "ab",
    count: 3,
    enabled: false,
    tags: ["a"],
  });
  expect(
    Object.keys(
      validateForm(form, {
        name: "A",
        count: "1.2",
        enabled: "false",
        tags: ["x"],
      }).errors,
    ),
  ).toHaveLength(4);
  expect(fieldOptions(form.requestedSchema.properties.tags!)).toEqual([
    { value: "a", label: "选项 A" },
    { value: "b", label: "b" },
  ]);
});

it("keeps disconnected drafts and binds only the same owner, scope and schema", async () => {
  const owner = {};
  const abort = new AbortController();
  const first = forms.offer(owner, "Agent", form, abort.signal);
  const original = forms.store.getState().pending[0]!;
  forms.store.getState().edit(original.id, { name: "saved" });
  abort.abort();
  expect(await first).toEqual({ action: "cancel" });
  forms.store.getState().answer(original.id, "accept");
  expect(forms.store.getState().pending[0]!.stale).toBe(true);
  const other = forms.offer(
    {},
    "Other",
    form,
    new AbortController().signal,
  );
  expect(forms.store.getState().pending[1]!.values).toEqual({});
  forms.store
    .getState()
    .answer(forms.store.getState().pending[1]!.id, "decline");
  expect(await other).toEqual({ action: "decline" });
  const rebound = forms.offer(
    owner,
    "Agent",
    form,
    new AbortController().signal,
  );
  expect(forms.store.getState().pending).toHaveLength(1);
  expect(forms.store.getState().pending[0]!.values).toEqual({
    name: "saved",
  });
  forms.store
    .getState()
    .answer(forms.store.getState().pending[0]!.id, "cancel");
  expect(await rebound).toEqual({ action: "cancel" });
});

it("surfaces request-scoped forms during initialize and advertises only form", async () => {
  const { client, peer } = createTransportPair();
  let initId: number;
  const session = createOwnedSession(client, {
    onElicitation: (value, signal, method) =>
      forms.offer({}, "Agent", value, signal, method),
  });
  peer.onLine((line) => {
    const message = JSON.parse(line) as {
      id: number | string;
      method?: string;
      params: { clientCapabilities: { elicitation?: unknown } };
      result?: unknown;
    };
    if (message.method === "initialize") {
      expect(message.params.clientCapabilities.elicitation).toEqual({
        form: {},
      });
      initId = message.id as number;
      peer.writeLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "form1",
          method: "elicitation/create",
          params: {
            mode: "form",
            message: "登录",
            requestId: initId,
            requestedSchema: {
              type: "object",
              properties: { account: { type: "string" } },
            },
          },
        }),
      );
    } else if (message.id === "form1") {
      expect(message.result).toEqual({
        action: "accept",
        content: { account: "demo" },
      });
      peer.writeLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: initId,
          result: {
            protocolVersion: 1,
            agentCapabilities: {},
            agentInfo: { name: "test", version: "1" },
          },
        }),
      );
    }
  });
  const initialized = session.initialize();
  await vi.waitFor(() =>
    expect(forms.store.getState().pending).toHaveLength(1),
  );
  const item = forms.store.getState().pending[0]!;
  forms.store.getState().edit(item.id, { account: "demo" });
  forms.store.getState().answer(item.id, "accept");
  await initialized;
});

it("cancels a pending form on transport exit", async () => {
  const { client, peer } = createTransportPair();
  const session = createOwnedSession(client, {
    onElicitation: (value, signal) =>
      forms.offer({}, "Agent", value, signal),
  });
  peer.onLine((line) => {
    const request = JSON.parse(line) as { id?: number; method?: string };
    if (request.method === "session/new") peer.writeLine(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { sessionId: "s1" } }));
  });
  await session.newSession("/project");
  peer.writeLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "f",
      method: "elicitation/create",
      params: {
        ...form,
        mode: "form",
        requestedSchema: { ...form.requestedSchema, type: "object" },
      },
    }),
  );
  await vi.waitFor(() =>
    expect(forms.store.getState().pending).toHaveLength(1),
  );
  peer.exit(1);
  expect(forms.store.getState().pending[0]!.stale).toBe(true);
});

it("Agent -32603 preserves error data and leaves the channel usable", async () => {
  const { client, peer } = createTransportPair();
  const failed = vi.fn();
  const connection = new JsonRpcConnection(client, { onFailure: failed });
  peer.onLine((line) => {
    const message = JSON.parse(line) as { id: number; method: string };
    peer.writeLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        ...(message.method === "session/prompt"
          ? {
              error: {
                code: -32603,
                message: "internal error",
                data: { reason: "upstream failed" },
              },
            }
          : { result: {} }),
      }),
    );
  });
  await expect(connection.request("session/prompt")).rejects.toMatchObject({
    jsonRpcCode: -32603,
    data: { reason: "upstream failed" },
  });
  expect(failed).not.toHaveBeenCalled();
  expect(
    appLogSink
      .snapshot()
      .some(
        (entry) =>
          entry.message === "Agent 返回 JSON-RPC 错误" &&
          entry.context.code === -32603 &&
          (entry.context.data as { reason: string }).reason ===
            "upstream failed",
      ),
  ).toBe(true);
  await expect(connection.request("session/list")).resolves.toEqual({});
});
