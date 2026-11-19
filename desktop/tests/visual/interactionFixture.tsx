import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SettingCard } from "../../src/shared/ui/SettingsPageParts.tsx";
import { InteractionPicker } from "../../src/plugins/project/ui/InteractionPicker.tsx";
import { MessageStreamPicker } from "../../src/plugins/project/ui/MessageStreamPicker.tsx";
import "../../src/shared/styles/index.css";

if (new URLSearchParams(location.search).get("theme") === "dark")
  document.documentElement.classList.remove("theme-warm");
function Fixture() {
  const [value, setValue] = useState<"queue" | "steer">("queue");
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5 p-4">
      <SettingCard label="信息流呈现方式">
        <MessageStreamPicker value="process" onChange={() => {}} />
      </SettingCard>
      <SettingCard label="交互行为">
        <InteractionPicker value={value} onChange={setValue} />
      </SettingCard>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
