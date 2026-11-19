export function browserObservationUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "about:") return "about:blank";
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return "about:blank";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "about:blank";
  }
}
