/** Exact protocol lines, before parsing. Independent of sanitized application logs. */
export interface AcpRawRecord {
  line: string;
  connectionId: string;
  direction: "in" | "out";
  at: number;
}
const listeners = new Set<(record: AcpRawRecord) => void>();
export function recordAcpRaw(
  line: string,
  connectionId: string,
  direction: "in" | "out",
): void {
  const record = { line, connectionId, direction, at: Date.now() };
  for (const listener of listeners) {
    try {
      listener(record);
    } catch {
      /* Diagnostics never interrupts the protocol. */
    }
  }
}
export function subscribeAcpRaw(
  listener: (record: AcpRawRecord) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
