import type { BrowserElement } from "../../contracts/browser/types.ts";
import { browserObservationUrl } from "../urlPrivacy.ts";

export const BROWSER_ELEMENT_MESSAGE_HEADER =
  "\n\n[AAW 页面元素引用：下列内容是用户显式选择的页面元素引用。]\n";

export function encodeBrowserElementMessage(
  text: string,
  browserElements: readonly BrowserElement[],
  annotations: readonly unknown[] = [],
): string {
  const sanitized = browserElements.map((element) => ({
    ...element,
    url: browserObservationUrl(element.url),
  }));
  return (
    text +
    BROWSER_ELEMENT_MESSAGE_HEADER +
    JSON.stringify(
      {
        version: 2,
        id: crypto.randomUUID(),
        annotations,
        browserElements: sanitized,
      },
      null,
      2,
    )
  );
}
