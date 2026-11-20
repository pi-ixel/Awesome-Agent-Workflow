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
    ).toBeLessThanOrEqual(5);
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

it("四条会话连接均有租约时仍可启动一条诊断连接", async () => {
  const { base, peers, open, connect } = fixture();
  const pool = base.createPool(connect);
  await pool.warm();
  const leases = Array.from({ length: 4 }, () => pool.openChannel());
  const probe = await base.createTransport(
    {
      command: ["probe"],
      isolated: true,
    },
    "diagnostic",
  );
  expect(probe).not.toBeNull();
  const probeConnection = base.createConnection(probe!, 1);
  expect(peers.filter(({ client }) => !client.isClosed)).toHaveLength(5);
  await expect(base.createTransport({ command: ["session"] })).rejects.toThrow(
    "额度已满",
  );
  await expect(
    base.createTransport({ command: ["probe"] }, "diagnostic"),
  ).rejects.toThrow("ACP 诊断连接正在使用");
  expect(open).toHaveBeenCalledTimes(5);
  await base.releaseConnection(probeConnection);
  const next = await base.createTransport({ command: ["probe"] }, "diagnostic");
  expect(next).not.toBeNull();
  await next!.close();
  await Promise.all(
    leases.map((lease) => lease.release(() => Promise.resolve())),
  );
  expect(pool.size).toBe(4);
  expect(peers.filter(({ client }) => !client.isClosed)).toHaveLength(4);
});

it("诊断启动中与退出未确认时仍占用诊断名额", async () => {
  const { base, open, peers } = fixture();
  let finish!: (transport: AcpTransport) => void;
  open.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = base.createTransport({ command: ["probe"] }, "diagnostic");
  await expect(
    base.createTransport({ command: ["probe"] }, "diagnostic"),
  ).rejects.toThrow("ACP 诊断连接正在使用");
  const normal = await base.createTransport({ command: ["agent"] });
  expect(normal).not.toBeNull();
  const peer = standardAcpPeer();
  peers.push(peer);
  finish(peer.client);
  const transport = (await pending)!;
  const kill = vi
    .spyOn(peer.client, "kill")
    .mockRejectedValue(new Error("退出未确认"));
  await expect(transport.kill()).rejects.toThrow("退出未确认");
  await expect(
    base.createTransport({ command: ["probe"] }, "diagnostic"),
  ).rejects.toThrow("尚未退出");
  kill.mockRestore();
  await transport.kill();
  await expect(
    base.createTransport({ command: ["probe"] }, "diagnostic"),
  ).resolves.not.toBeNull();
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
