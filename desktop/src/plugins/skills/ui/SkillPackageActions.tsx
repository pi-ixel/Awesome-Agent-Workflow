import { useRef, useState } from "react";
import { ActionButton } from "../../../shared/ui/controls.tsx";

import type { HostStorage } from "../../host/types.ts";
import type { SkillPackage, SkillPackageManager } from "../types.ts";

import { packageReceiptsKey, receipts } from "./skillPackageReceipts.ts";

interface Props {
  manager: SkillPackageManager;
  storage: HostStorage;

  changed: () => void;
  report: (lines: string[]) => void;
}
export function SkillPackageActions({
  manager,
  storage,
  changed,
  report,
}: Props) {
  const [busy, setBusy] = useState(false);
  const gate = useRef(false);
  async function run(operation: () => Promise<void>) {
    if (gate.current) return;
    gate.current = true;
    setBusy(true);
    try {
      await operation();
    } catch (e) {
      report([String(e)]);
    } finally {
      gate.current = false;
      setBusy(false);
    }
  }

  let items: SkillPackage[];
  try {
    items = receipts(storage);
  } catch {
    return <p>无法读取插件恢复记录</p>;
  }
  return (
    <>
      {items.map((p) => (
        <div className="flex items-center justify-between gap-2 p-2" key={p.id}>
          <span>{p.id} · 插件包</span>
          <ActionButton
            tone="secondary" className="px-2 py-1 text-ui-xs"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                report([await manager.install(p)]);
                storage.setItem(
                  packageReceiptsKey,
                  JSON.stringify(
                    receipts(storage).filter((r) => r.id !== p.id),
                  ),
                );
                changed();
              })
            }
          >
            通过 Agent 重新安装
          </ActionButton>
        </div>
      ))}
    </>
  );
}
