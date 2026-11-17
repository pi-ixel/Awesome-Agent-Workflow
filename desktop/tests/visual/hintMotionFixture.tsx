import { useState } from "react";
import { HintNumber } from "../../src/shared/ui/controls/HintNumber.tsx";
import { HintSurface } from "../../src/shared/ui/controls/HintSurface.tsx";

export function HintMotionFixture() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("16.4 tok/s");

  return (
    <div className="space-x-6 p-8">
      <button type="button" onClick={() => setOpen(true)}>打开统计</button>
      <button type="button" onClick={() => setOpen(false)}>关闭统计</button>
      <button type="button" onClick={() => setValue("16.9 tok/s")}>第一次刷新</button>
      <button type="button" onClick={() => setValue("16.2 tok/s")}>第二次刷新</button>
      <button type="button" onClick={() => setValue("94.7 tok/s")}>大幅跳变</button>
      <button type="button" onClick={() => setValue("未知")}>未知值</button>
      <button type="button" data-hint="配额 500 tok">文字提示</button>
      <HintSurface
        open={open}
        unfoldFrom="bottom"
        role="dialog"
        aria-label="统计示例"
        data-testid="hint-motion-card"
        className="fixed top-28 left-12 w-64 p-3 font-mono"
      >
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline text-ui-base">
          <dt data-testid="hint-baseline-reference" className="font-sans">16.4 tok/s</dt>
          <dd data-testid="hint-motion-value" className="text-right"><HintNumber value={value} /></dd>
          <dt className="font-sans">缓存命中率</dt>
          <dd data-testid="hint-alignment-peer" className="text-right"><HintNumber value="83.8%" /></dd>
        </dl>
        <button type="button" className="block">浮框内操作</button>
      </HintSurface>
    </div>
  );
}
