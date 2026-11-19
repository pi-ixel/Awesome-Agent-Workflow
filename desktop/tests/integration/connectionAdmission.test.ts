import { afterEach, expect, it, vi } from "vitest";
import { DesktopAcpConnection } from "../../src/plugins/acpConnection/lifecycle/connectionService.ts";
import type { HostService } from "../../src/plugins/host/service.ts";
import type { AcpTransport } from "../../src/plugins/host/types.ts";
import { standardAcpPeer } from "../helpers/standardAcpPeer.ts";

const owners: DesktopAcpConnection[] = [];
function fixture() {
  const peers: ReturnType<typeof standardAcpPeer>[] = [];
  const open = vi.fn(() => {
    const peer = standardAcpPeer();
    peers.push(peer);
    expect(
      peers.filter(({ client }) => !client.isClosed).length,
    ).toBeLessThanOrEqual(4);
    return Promise.resolve(peer.client);
  });
  const base = new DesktopAcpConnection(
    {
      isNative: () => false,
      openDevelopmentAcpTransport: open,
    } as unknown as HostService,
    {},
  );
  owners.push(base);
  const connect = async () => {
    const transport = await base.createTransport({ command: ["agent"] });
    if (!transport) throw new Error("没有传输");
    const connection = base.createConnection(transport, 1);
    const channel = connection.openChannel();
    await channel.port.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    channel.close();
    return connection;
  };
  return { base, peers, open, connect };
}
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.shutdown();
});

it("启动中和已返回但尚未绑定连接的传输都计入总额度", async () => {
  const { base, open, peers } = fixture();
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const create = open.getMockImplementation()!;
  open.mockImplementation(async () => {
    await gate;
    return create();
  });
  const pending = Array.from({ length: 4 }, () =>
    base.createTransport({ command: ["agent"] }),
  );
  await expect(base.createTransport({ command: ["fifth"] })).rejects.toThrow(
    "额度已满",
  );
  finish();
  const transports = await Promise.all(pending);
  expect(peers).toHaveLength(4);
  await expect(base.createTransport({ command: ["sixth"] })).rejects.toThrow(
    "额度已满",
  );
  await transports[0]!.close();
  const replacement = await base.createTransport({ command: ["replacement"] });
  expect(replacement).not.toBeNull();
  expect(peers.filter(({ client }) => !client.isClosed)).toHaveLength(4);
});

it("Agent 探查借用空闲槽，所有槽有租约时不会越过四条限制", async () => {
  const { base, peers, open, connect } = fixture();
  const pool = base.createPool(connect);
  await pool.warm();
  const leases = Array.from({ length: 4 }, () => pool.openChannel());
  await expect(
    base.createTransport({ command: ["probe"], isolated: true }),
  ).rejects.toThrow("额度已满");
  expect(open).toHaveBeenCalledTimes(4);
  await leases[0]!.release(() => Promise.resolve());
  const probe = await base.createTransport({
    command: ["probe"],
    isolated: true,
  });
  expect(probe).not.toBeNull();
  const probeConnection = base.createConnection(probe!, 1);
  expect(peers.filter(({ client }) => !client.isClosed)).toHaveLength(4);
  await pool.warm();
  expect(open).toHaveBeenCalledTimes(5);
  await base.releaseConnection(probeConnection);
  await pool.warm();
  expect(pool.size).toBe(4);
  expect(peers.filter(({ client }) => !client.isClosed)).toHaveLength(4);
});

it("未确认退出的裸传输仍占额度，不能因未创建协议连接而绕过", async () => {
  const { base, peers } = fixture();
  const transports = await Promise.all(
    Array.from({ length: 4 }, () =>
      base.createTransport({ command: ["agent"] }),
    ),
  );
  const kill = vi
    .spyOn(peers[0]!.client, "kill")
    .mockRejectedValue(new Error("退出未确认"));
  await expect(transports[0]!.kill()).rejects.toThrow("退出未确认");
  await expect(base.createTransport({ command: ["fifth"] })).rejects.toThrow(
    "额度已满",
  );
  kill.mockRestore();
});

it("退出等待迟到的启动结果并回收进程", async () => {
  const { base, peers, open } = fixture();
  let finish!: (transport: AcpTransport) => void;
  open.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = base
    .createTransport({ command: ["late"] })
    .catch((error: unknown) => error);
  await vi.waitFor(() => expect(finish).toBeDefined());
  const closing = base.shutdown();
  const peer = standardAcpPeer();
  peers.push(peer);
  finish(peer.client);
  expect(await pending).toBeInstanceOf(Error);
  await closing;
  expect(peer.client.isClosed).toBe(true);
});
