import { createRoot } from "react-dom/client";
import { FilePreview } from "../../src/plugins/documents/ui/FilePreview.tsx";
import { createDocuments } from "../../src/plugins/documents/files/documents.ts";
import { DocumentAnnotationContext } from "../../src/plugins/documents/ui/annotationView.ts";
import type { ProjectAnnotationEditor } from "../../src/plugins/project/service.ts";
import type { AnnotationDraftTarget } from "../../src/plugins/project/types.ts";
import type { DocumentAnnotation } from "../../src/shared/annotations/types.ts";
import { GitDiffView } from "../../src/plugins/git/ui/GitDiffView.tsx";
import type { GitService } from "../../src/plugins/git/service.ts";
import type { GitSnapshot } from "../../src/plugins/host/types.ts";
import "../../src/shared/styles/index.css";

const project = "D:/test";
const path = "server.log";
const token = "0123456789".repeat(24);
const content = `${token}\nnext log entry`;
const documents = createDocuments({
  preview: () =>
    Promise.resolve({
      kind: "text",
      content,
      bytes: content.length,
      mime: "text/plain",
    }),
  assetUrl: () => undefined,
  stat: () => Promise.reject(new Error("unexpected stat")),
  directory: () => Promise.reject(new Error("unexpected directory")),
  listWorkspaceFiles: () => Promise.resolve([path]),
  openInFileManager: () => Promise.resolve(),
  saveMarkdown: () => Promise.resolve(),
  watch: () => Promise.resolve(() => {}),
});
const target = Object.freeze({}) as AnnotationDraftTarget;
const annotations: readonly DocumentAnnotation[] = [];
const editor: ProjectAnnotationEditor = {
  current: () => target,
  read: () => annotations,
  subscribeDrafts: () => () => {},
  subscribeTarget: () => () => {},
  ensure: () => {},
  upsert: () => null,
  remove: () => true,
  followPromotion: () => () => {},
  showAfterSave: () => Promise.resolve(undefined),
};
const change = {
  path,
  oldPath: null,
  source: "unstaged" as const,
  status: "modified",
};
const snapshot: GitSnapshot = {
  repoRoot: project,
  branch: "main",
  changes: [change],
  watchPaths: [],
};
const gitState = { data: snapshot, loading: false };
const git: GitService = {
  reviewRailWidth: 200,
  setReviewRailWidth: () => {},
  status: () => Promise.resolve(snapshot),
  query: () => ({
    getSnapshot: () => gitState,
    subscribe: () => () => {},
    refresh: () => Promise.resolve(),
    invalidate: () => {},
  }),
  diff: () =>
    Promise.resolve({ patch: `@@ -1 +1 @@\n-old\n+${token}\n`, notice: null }),
};

createRoot(document.getElementById("root")!).render(
  <div className="flex gap-4 p-6 pt-24">
    <section
      aria-label="日志预览"
      className="h-[460px] w-[340px] overflow-hidden"
    >
      <DocumentAnnotationContext.Provider value={editor}>
        <FilePreview
          documents={documents}
          path={`${project}/${path}`}
          project={project}
          onOpen={() => {}}
        />
      </DocumentAnnotationContext.Provider>
    </section>
    <section
      aria-label="旧 Git 差异预览"
      className="h-[460px] w-[340px] overflow-hidden"
    >
      <GitDiffView
        project={project}
        gitService={git}
        change={change}
        repoRoot={project}
        onFile={() => {}}
      />
    </section>
  </div>,
);
