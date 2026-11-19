import assert from "node:assert/strict";
import {
  browserSleep as sleep,
  connectBrowserMain,
} from "./browserCdpClient.ts";

const main = await connectBrowserMain();
const evaluate = (expression: string) => main.evaluate(expression);
const prompt =
  "请依次调用 browser_open 打开 http://127.0.0.1:8765/，再调用 browser_snapshot 读取页面，最后调用 browser_screenshot 截图。不要调用其他工具。完成后用一句话报告页面标题。";

async function startNewSession(): Promise<void> {
  await evaluate(
    `document.querySelector("button[aria-label='新建会话']")?.click()`,
  );
  await sleep(300);
  const clicked = await evaluate(
    `(()=>{const panel=document.querySelector("div[aria-label='新建会话面板']");const project=panel?.querySelector("button[title]");if(!project)return false;project.click();return true;})()`,
  );
  assert.equal(clicked, true);
  await sleep(4000);
}

try {
  console.log(
    JSON.stringify({
      stage: "initial",
      text: String(await evaluate("document.body.innerText")).slice(0, 2000),
      buttons: await evaluate(
        `JSON.stringify([...document.querySelectorAll("button")].map(button=>({text:button.innerText,aria:button.getAttribute("aria-label")})))`,
      ),
    }),
  );
  let hasComposer = await evaluate(
    `Boolean(document.querySelector("textarea") || document.querySelector("input[placeholder]"))`,
  );
  if (
    !hasComposer ||
    String(await evaluate("document.body.innerText")).includes("连接失败")
  ) {
    await startNewSession();
    hasComposer = await evaluate(
      `Boolean(document.querySelector("textarea") || document.querySelector("input[placeholder]"))`,
    );
  }
  if (
    String(await evaluate("document.body.innerText")).includes("新建会话继续")
  ) {
    await evaluate(
      `(()=>{const button=[...document.querySelectorAll("button")].find(button=>button.innerText==="新建会话继续");button?.click();return Boolean(button);})()`,
    );
    await sleep(5000);
  }
  if (!hasComposer)
    console.log(
      JSON.stringify({
        stage: "composer-missing",
        text: await evaluate("document.body.innerText"),
      }),
    );
  assert.equal(hasComposer, true);

  const filled = await evaluate(`(()=>{
    const input=document.querySelector("textarea")||document.querySelector("input[placeholder]");
    if(!input)return false;
    const prototype=input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype,"value")?.set?.call(input,${JSON.stringify(prompt)});
    input.dispatchEvent(new Event("input",{bubbles:true}));
    input.dispatchEvent(new Event("change",{bubbles:true}));
    return input.value===${JSON.stringify(prompt)};
  })()`);
  assert.equal(filled, true);
  await sleep(300);
  const composerState = await evaluate(
    `JSON.stringify([...document.querySelectorAll("button")].map(button=>({text:button.innerText,aria:button.getAttribute("aria-label"),disabled:button.disabled})).filter(button=>/发送|send/i.test((button.aria??"")+" "+button.text)))`,
  );
  console.log(
    JSON.stringify({
      stage: "composer",
      controls: composerState,
      value: await evaluate(`document.querySelector("textarea")?.value`),
      text: String(await evaluate("document.body.innerText")).slice(-1200),
    }),
  );
  const sent = await evaluate(`(()=>{
    const buttons=[...document.querySelectorAll("button")];
    const button=buttons.find(button=>/发送|send/i.test((button.getAttribute("aria-label")??"")+" "+button.innerText)&&!button.disabled);
    if(!button)return false;
    button.click();
    return true;
  })()`);
  assert.equal(sent, true);

  let transcript = "";
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await sleep(2000);
    transcript = String(await evaluate("document.body.innerText"));
    if (
      transcript.includes("AAW Browser 验证页") &&
      transcript.includes("browser_screenshot")
    )
      break;
  }
  assert.match(transcript, /browser_open/);
  assert.match(transcript, /browser_snapshot/);
  assert.match(transcript, /browser_screenshot/);
  assert.match(transcript, /AAW Browser 验证页/);
  console.log(
    JSON.stringify(
      { status: "passed", assertions: 7, transcript: transcript.slice(-6000) },
      null,
      2,
    ),
  );
} finally {
  main.close();
}
