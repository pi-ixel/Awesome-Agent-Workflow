import { expect, test } from "@playwright/test";

const kinds = ["fetch", "img", "audio", "video"] as const;
const hosts = ["api.tool.test", "assets.tool.test"];

test("工具预览直接访问 API 和媒体，外部脚本与样式由沙箱拦截", async ({
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
  await page.goto("/tests/visual/toolNetworkPolicyFixture.html");
  const body = page
    .frameLocator('iframe[aria-label="页面工具预览"]')
    .locator("body");
  await expect(body).toContainText("资源加载验证");
  const result = await body.evaluate(
    async (_, { hosts, kinds }) => {
      const blocked: string[] = [];
      document.addEventListener("securitypolicyviolation", (event) =>
        blocked.push(event.effectiveDirective),
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
              const response = await fetch(url);
              if (!response.ok) throw new Error(`请求失败：${url}`);
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
              if (element instanceof HTMLMediaElement) element.preload = "auto";
              element.src = url;
              document.body.append(element);
              if (element instanceof HTMLMediaElement) element.load();
            });
          }),
        ),
      );
      const script = document.createElement("script");
      script.src = `https://${hosts[0]}/external.js`;
      const stylesheet = document.createElement("link");
      stylesheet.rel = "stylesheet";
      stylesheet.href = `https://${hosts[0]}/external.css`;
      await Promise.all(
        [script, stylesheet].map(
          (element) =>
            new Promise<void>((resolve) => {
              element.addEventListener("error", () => resolve(), {
                once: true,
              });
              element.addEventListener("load", () => resolve(), { once: true });
              document.head.append(element);
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
  expect([...requests].sort()).toEqual(
    hosts.flatMap((host) => kinds.map((kind) => `${host}/${kind}`)).sort(),
  );
  expect(result.blocked.sort()).toEqual(["script-src-elem", "style-src-elem"]);
});
