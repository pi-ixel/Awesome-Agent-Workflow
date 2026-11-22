import { createTerminalService } from "../../src/plugins/terminal/pty/terminal.ts";
import { TerminalSessionView } from "../../src/plugins/terminal/ui/TerminalSessionView.tsx";
import type { PtyOutputWire } from "../../src/plugins/host/types.ts";
import { terminalDock } from "../../src/plugins/terminal/ui/workbench.ts";
import ContentArea from "../../src/plugins/workbench/ui/ContentArea.tsx";
import { createGitWorkbench } from "../helpers/gitWorkbench.tsx";

let receiveOutput: ((payload: PtyOutputWire) => void) | undefined;
let nextHandle = 1;
const terminal = createTerminalService(
  {
    isNative: () => true,
    homeDir: () => Promise.resolve("/demo"),
    listenOutput: (receive) => {
      receiveOutput = receive;
      return Promise.resolve(() => {
        receiveOutput = undefined;
      });
    },
    listenExit: () => Promise.resolve(() => {}),
    spawn: () => {
      const handle = nextHandle++;
      receiveOutput?.({
        handle,
        data: btoa("Desktop appearance test\r\n$ "),
      });
      return Promise.resolve({
        handle,
        pid: handle,
        shell: "/bin/sh",
        shellName: "sh",
      });
    },
    write: (handle, data) => {
      receiveOutput?.({ handle, data: btoa(data) });
      return Promise.resolve();
    },
    resize: () => Promise.resolve(),
    kill: () => Promise.resolve(),
    release: () => Promise.resolve(),
  },
  () => false,
);
const { Wrapper, workbench } = createGitWorkbench();
workbench.register(
  "docks",
  terminalDock(terminal, async () => {}),
);
terminal.openShellTab("/demo");
const tab = terminal.tabs.getState().tabs[0]!;

export function TerminalDockFixture() {
  return (
    <div className="h-80 min-w-0">
      <Wrapper>
        <ContentArea />
      </Wrapper>
    </div>
  );
}

export function TerminalAppearanceFixture() {
  return (
    <div className="flex h-64 min-w-0 flex-col">
      <TerminalSessionView
        visible
        terminal={terminal}
        project="/demo"
        tab={tab}
      />
    </div>
  );
}
