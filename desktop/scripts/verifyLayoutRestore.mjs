import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

/** 独立测试窗口记录恢复后的逐帧栏宽，不操作用户现有窗口或项目。 */
export async function verifyLayoutRestore({ evaluate, invoke, waitFor }) {
  await evaluate(invoke("plugin:window|show"));
  await evaluate(invoke("plugin:window|set_focus"));
  const files = `document.querySelector('[data-hint="浏览项目文件"]')`;
  await waitFor("测试项目文件入口", () => evaluate(`Boolean(${files})`));
  await evaluate(
    `document.documentElement.style.setProperty('--aaw-left-w', '400px'); ${files}.click()`,
  );
  await waitFor("左右栏并排布局", () =>
    evaluate(`Boolean(document.querySelector('[aria-label="调整右栏宽度"]'))`),
  );
  await waitFor("右栏开启动效已结束", () =>
    evaluate(
      `!document.querySelector('[data-panel-dragging][data-layout-moving]')`,
    ),
  );
  const initial = await evaluate(`new Promise(resolve => {
    const left = document.querySelector('[data-edge-drawer="left"]');
    const right = document.querySelector('[data-edge-drawer="right"]');
    window.__layoutRestoreRead = () => ({
      viewport: innerWidth,
      left: left.getBoundingClientRect().width,
      right: right.getBoundingClientRect().width,
      split: Boolean(document.querySelector('[aria-label="调整右栏宽度"]')),
    });
    window.__layoutRestoreFrames = [];
    window.__layoutRestoreEvents = [];
    let frame = 0;
    const sample = () => {
      cancelAnimationFrame(frame);
      let remaining = 24;
      const tick = () => {
        if (!document.hidden && innerWidth > 0 && innerHeight > 0) window.__layoutRestoreFrames.push(window.__layoutRestoreRead());
        if (--remaining > 0) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    };
    window.__layoutRestoreSample = sample;
    addEventListener('resize', () => {
      window.__layoutRestoreEvents.push({ width: innerWidth, height: innerHeight, hidden: document.hidden });
      sample();
    });
    document.addEventListener('visibilitychange', sample);
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(window.__layoutRestoreRead())));
  })`);
  assert.ok(initial.left >= 400 && initial.split, JSON.stringify(initial));
  for (const maximized of [true, false]) {
    await evaluate(invoke("plugin:window|toggle_maximize"));
    await waitFor("原生最大化状态已更新", () =>
      evaluate(
        `(${invoke("plugin:window|is_maximized")}).then(value => value === ${maximized})`,
      ),
    );
    const size = await evaluate(invoke("plugin:window|inner_size"));
    const scale = await evaluate(invoke("plugin:window|scale_factor"));
    await waitFor("WebView 跟随正常窗口尺寸", () =>
      evaluate(
        `Math.abs(innerWidth - ${size.width / scale}) <= 1 && Math.abs(innerHeight - ${size.height / scale}) <= 1`,
      ),
    );
  }
  await waitFor("普通还原后的栏宽已稳定", () =>
    evaluate(
      `Math.abs(window.__layoutRestoreRead().right - ${initial.right}) <= 1`,
    ),
  );
  for (let cycle = 0; cycle < 3; cycle++) {
    await evaluate("window.__layoutRestoreFrames = []");
    await evaluate(invoke("plugin:window|minimize"));
    await waitFor("原生窗口已最小化", () =>
      evaluate(invoke("plugin:window|is_minimized")),
    );
    await delay(200);
    await evaluate(
      `window.__layoutRestoreFrames = []; window.__layoutRestoreSample(); ${invoke("plugin:window|unminimize")}`,
    );
    await evaluate(invoke("plugin:window|set_focus"));
    await waitFor("原生窗口已恢复", () =>
      evaluate(
        `(${invoke("plugin:window|is_minimized")}).then(value => !value)`,
      ),
    );
    await waitFor("恢复后逐帧取样完成", () =>
      evaluate("window.__layoutRestoreFrames.length >= 20"),
    );
    const frames = await evaluate("window.__layoutRestoreFrames");
    const events = await evaluate("window.__layoutRestoreEvents");
    console.log(
      "原生恢复栏宽取样",
      JSON.stringify({ cycle, initial, events, frames }),
    );
    for (const frame of frames) {
      assert.equal(frame.viewport, initial.viewport, "恢复不应改变窗口宽度");
      assert.ok(
        Math.abs(frame.left - initial.left) <= 1,
        "恢复首帧左栏不能压缩到最小宽度",
      );
      assert.ok(
        Math.abs(frame.right - initial.right) <= 1,
        "恢复首帧右栏不能跳变",
      );
      assert.ok(frame.split, "恢复不应短暂切换到遮罩布局");
    }
  }
  console.log(
    "PASS: 正常最大化与还原更新视口；最小化恢复三轮的左右栏首帧宽度和并排布局稳定",
  );
}
