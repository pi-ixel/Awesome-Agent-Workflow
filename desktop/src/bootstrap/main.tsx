// Load only the entry point for the selected window.
if (new URLSearchParams(location.search).get("diagnostics") === "1") {
  void import("./diagnosticsMain.tsx");
} else {
  void import("./migrateSessionFiles.tsx")
    .then(({ migrateSessionFiles }) => migrateSessionFiles())
    .then(() => import("./appMain.tsx"));
}
