// Keep diagnostics isolated: importing App would initialize agent and archive services.
if (new URLSearchParams(location.search).get("diagnostics") === "1") {
  void import("./diagnosticsMain.tsx");
} else {
  void import("./appMain.tsx");
}
