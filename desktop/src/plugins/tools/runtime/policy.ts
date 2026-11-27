import { readNetworkRule, type ToolPermissions } from "../types.ts";

/** 与原生 protocol.rs 保持相同的基底，外部资源统一按联网声明放行。 */
const basePolicy = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'self'",
  "style-src 'unsafe-inline' 'self'",
  "font-src 'self' data:",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
];

export function toolFramePolicy(permissions?: ToolPermissions): string {
  const network = readNetworkRule(permissions);
  const remote = !network.enabled
    ? ""
    : network.hosts.length
      ? network.hosts
          .filter(
            (host) =>
              typeof host === "string" &&
              host.length <= 260 &&
              /^[a-z\d.*:-]+$/i.test(host),
          )
          .join(" ")
      : "https: http:";
  const suffix = remote ? ` ${remote}` : "";
  return [
    ...basePolicy,
    `connect-src 'self'${suffix}`,
    `img-src 'self' data: blob:${suffix}`,
    `media-src 'self' data: blob:${suffix}`,
  ].join("; ");
}
