/** Local-only notification when a reverse-request response is accepted by the transport. */
export const responseWriteObserver = Symbol("response-write-observer");
export interface ResponseWriteObserved {
  [responseWriteObserver](written: boolean): void;
}
export function hasResponseWriteObserver(value: unknown): boolean {
  return typeof value === "object" && value !== null &&
    typeof (value as Partial<ResponseWriteObserved>)[responseWriteObserver] === "function";
}
export function observeResponseWrite(value: unknown, written: boolean): void {
  if (typeof value !== "object" || value === null) return;
  const observer = (value as Partial<ResponseWriteObserved>)[
    responseWriteObserver
  ];
  if (typeof observer === "function") {
    try {
      observer(written);
    } catch {
      /* An observer must not change the wire response. */
    }
  }
}
