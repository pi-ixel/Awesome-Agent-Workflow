import { describe, expect, it, vi } from "vitest";
import { SessionFactory } from "../../src/runtime/acp/SessionFactory.ts";
import { session } from "../helpers/sessionRuntime.ts";

describe("SessionFactory creation", () => {
  it("shares an in-flight new request and allows retry after failure", async () => {
    const runtime = session("/project");
    const factory = new SessionFactory();
    const create = vi
      .spyOn(runtime.session, "newSession")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ sessionId: "created" });
    const first = factory.ensureCreated(runtime);
    expect(factory.ensureCreated(runtime)).toBe(first);
    await expect(first).rejects.toThrow("offline");
    await expect(factory.ensureCreated(runtime)).resolves.toEqual({
      sessionId: "created",
    });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("rejects late creation after closure or connection replacement", async () => {
    for (const replace of [false, true]) {
      const runtime = session("/project");
      const factory = new SessionFactory();
      let finish!: (result: { sessionId: string }) => void;
      const create = vi.spyOn(runtime.session, "newSession").mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const pending = factory.ensureCreated(runtime);
      await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
      if (replace) runtime.session = session("/project").session;
      else runtime.disposed = true;
      finish({ sessionId: "late" });
      await expect(pending).rejects.toThrow("旧连接已失效");
      expect(runtime.store.getState().activeSessionId).toBeNull();
    }
  });

  it("does not issue new when closed before the request starts", async () => {
    const runtime = session("/project");
    const create = vi.spyOn(runtime.session, "newSession");
    const result = new SessionFactory().ensureCreated(runtime);
    runtime.disposed = true;
    await expect(result).rejects.toThrow("旧连接已失效");
    expect(create).not.toHaveBeenCalled();
  });
});
