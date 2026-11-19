import { describe, expect, it, vi } from "vitest";
import { disposeBrowserSession } from "../../src/plugins/project/sessions/sessionCoordinator.ts";
import { createTestBrowserHost } from "../helpers/browserHost.ts";

describe("TD-04-I05 会话原生资源清理协调", () => {
  it("先关闭目标会话再撤销端点，且不影响其他会话", async () => {
    const browser = createTestBrowserHost();
    const closeSession = vi.spyOn(browser, "closeSession");
    const revokeMcpEndpoint = vi.spyOn(browser, "revokeMcpEndpoint");
    const endpoint = await browser.createMcpEndpoint();

    await disposeBrowserSession(browser, "session-a", endpoint.endpointId);

    expect(closeSession).toHaveBeenCalledExactlyOnceWith("session-a");
    expect(revokeMcpEndpoint).toHaveBeenCalledExactlyOnceWith(
      endpoint.endpointId,
    );
    expect(closeSession.mock.invocationCallOrder[0]!).toBeLessThan(
      revokeMcpEndpoint.mock.invocationCallOrder[0]!,
    );
    expect(closeSession).not.toHaveBeenCalledWith("session-b");
  });
});

describe("TD-04-I11 清理失败必须 fail-closed", () => {
  it("原生关闭失败时不撤销端点，也不伪造清理成功", async () => {
    const browser = createTestBrowserHost();
    vi.spyOn(browser, "closeSession").mockRejectedValue(
      new Error("CLOSE_FAILED"),
    );
    const revokeMcpEndpoint = vi.spyOn(browser, "revokeMcpEndpoint");

    await expect(
      disposeBrowserSession(browser, "session-a", "endpoint-a"),
    ).rejects.toThrow("CLOSE_FAILED");
    expect(revokeMcpEndpoint).not.toHaveBeenCalled();
  });
});
