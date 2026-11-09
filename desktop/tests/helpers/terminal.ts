import { createTerminalService } from "../../src/plugins/terminal/service.ts";
import { terminalHost } from "../../src/plugins/host/terminal.ts";

export function createTestTerminal(isExiting = () => false) {
  return createTerminalService(terminalHost, isExiting);
}
