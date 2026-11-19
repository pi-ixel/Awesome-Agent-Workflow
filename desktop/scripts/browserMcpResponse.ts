export type BrowserMcpContent = Record<string, unknown> & {
  control?: { controller: string };
  result?: string;
  status?: string;
  tabId?: string;
};

export type BrowserMcpResponse = {
  result?: { structuredContent?: BrowserMcpContent };
  error?: { message: string };
};
