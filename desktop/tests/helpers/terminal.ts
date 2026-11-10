import { createTerminalService } from "../../src/plugins/terminal/pty/terminal.ts";
import { terminalHost } from "../../src/plugins/host/process/terminal.ts";

export function createTestTerminal(isExiting = () => false) {
  return createTerminalService(terminalHost, isExiting);
}
