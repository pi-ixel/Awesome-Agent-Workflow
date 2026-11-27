import { expect, test } from "@playwright/test";

const kinds = ["fetch", "img", "audio", "video"] as const;
const hosts = ["api.allowed.tool.test", "denied.tool.test"];

for (const mode of ["offline", "hosts", "open", "legacy"] as const) {
  test(`工具预览 ${mode}：连接、图片和音视频遵守同一联网限制`, async ({
    page,
  }) => {
    const requests = new Set<string>();
    await page.route("https://*.tool.test/**", async (route) => {
      const url = new URL(route.request().url());
      requests.add(`${url.hostname}${url.pathname}`);
      await route.fulfill({
        status: 200,
        headers: { "Access-Control-Allow-Origin": "*" },
        contentType: url.pathname === "/img" ? "image/svg+xml" : "text/plain",
        body:
          url.pathname === "/img"
            ? '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'
            : "",
      });
    });
    await page.goto(
      `/tests/visual/toolNetworkPolicyFixture.html?network=${mode}`,
    );
    const body = page
      .frameLocator('iframe[aria-label="工具联网限制"]')
      .locator("body");
    await expect(body).toContainText("网络策略验证");
    const result = await body.evaluate(
      async (_, { hosts, kinds }) => {
        const blocked: string[] = [];
        document.addEventListener("securitypolicyviolation", (event) =>
          blocked.push(event.blockedURI),
        );
        const loadImage = (src: string) =>
          new Promise<boolean>((resolve) => {
            const image = new Image();
            image.onload = () => resolve(true);
            image.onerror = () => resolve(false);
            image.src = src;
          });
        const svg =
          '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';
        const blob = URL.createObjectURL(
          new Blob([svg], { type: "image/svg+xml" }),
        );
        const localImages = await Promise.all([
          loadImage(`data:image/svg+xml,${encodeURIComponent(svg)}`),
          loadImage(blob),
        ]);
        URL.revokeObjectURL(blob);
        await Promise.all(
          hosts.flatMap((host) =>
            kinds.map(async (kind) => {
              const url = `https://${host}/${kind}`;
              if (kind === "fetch") {
                await fetch(url).catch(() => {});
                return;
              }
              await new Promise<void>((resolve) => {
                const element = document.createElement(kind);
                const timer = window.setTimeout(done, 5000);
                function done() {
                  clearTimeout(timer);
                  element.remove();
                  resolve();
                }
                element.addEventListener("load", done, { once: true });
                element.addEventListener("error", done, { once: true });
                element.addEventListener("loadedmetadata", done, {
                  once: true,
                });
                if (element instanceof HTMLMediaElement)
                  element.preload = "auto";
                element.src = url;
                document.body.append(element);
                if (element instanceof HTMLMediaElement) element.load();
              });
            }),
          ),
        );
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        return { blocked, localImages };
      },
      { hosts, kinds },
    );
    expect(result.localImages).toEqual([true, true]);
    const allowedHosts =
      mode === "offline" ? [] : mode === "hosts" ? hosts.slice(0, 1) : hosts;
    expect([...requests].sort()).toEqual(
      allowedHosts
        .flatMap((host) => kinds.map((kind) => `${host}/${kind}`))
        .sort(),
    );
    for (const host of hosts.filter((host) => !allowedHosts.includes(host))) {
      expect(
        result.blocked.filter((uri) => uri.includes(host)).length,
      ).toBeGreaterThanOrEqual(kinds.length);
    }
  });
}
