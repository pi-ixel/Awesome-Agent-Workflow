import { expect, it } from "vitest";
import { AcpSession } from "../../src/acp/session.ts";
import { createTransportPair } from "../../src/acp/transport/inMemoryTransport.ts";
import { parseConfigOptions } from "../../src/acp/configOptions.ts";

it("uses standard grouped configOptions and confirmed updates to select models", async () => {
  const { client, peer } = createTransportPair();
  const session = new AcpSession(client);
  let selected = "a";
  const methods: string[] = [];
  const config = () => [
    {
      type: "select",
      id: "llm",
      category: "model",
      name: "Model",
      currentValue: selected,
      options: [
        {
          group: "provider",
          name: "Provider",
          options: [
            { value: "a", name: "Model A" },
            { value: "b", name: "Model B" },
          ],
        },
      ],
    },
  ];
  peer.onLine((line) => {
    const request = JSON.parse(line) as {
      id: number;
      method: string;
      params: { value?: string };
    };
    methods.push(request.method);
    if (request.method === "session/set_config_option")
      selected = request.params.value!;
    peer.writeLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result:
          request.method === "initialize"
            ? {
                protocolVersion: 1,
                agentInfo: { name: "standard" },
                agentCapabilities: {},
              }
            : { sessionId: "s", configOptions: config() },
      }),
    );
  });
  await session.initialize();
  await session.newSession("D:/project");
  expect(session.models?.availableModels.map((model) => model.name)).toEqual([
    "Model A",
    "Model B",
  ]);
  await session.setModel("b");
  expect(methods).toContain("session/set_config_option");
  expect(methods).not.toContain("session/set_model");
  expect(session.models?.currentModelId).toBe("b");
  selected = "a";
  peer.writeLine(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: config(),
        },
      },
    }),
  );
  expect(session.models?.currentModelId).toBe("a");
  await session.kill();
});

it("does not invent model settings from unknown configuration types", () => {
  expect(parseConfigOptions([{ type: "future", id: "model" }, null])).toEqual(
    [],
  );
});

it("returns the standard method-not-found code for unsupported reverse requests", async () => {
  const { client, peer } = createTransportPair();
  const session = new AcpSession(client);
  const reply = new Promise<{ error: { code: number } }>((resolve) =>
    peer.onLine((line) =>
      resolve(JSON.parse(line) as { error: { code: number } }),
    ),
  );
  peer.writeLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "elicitation/create",
      params: {},
    }),
  );
  expect((await reply).error.code).toBe(-32601);
  await session.kill();
});
