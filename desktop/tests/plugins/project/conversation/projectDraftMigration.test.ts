import { createAnnotationDraftStore } from "../../../../src/plugins/project/composer/annotationDraftStore.ts";
import { webviewStorage } from "../../../../src/plugins/host/storage/storage.ts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  draftScopeKey,
  legacyNewDraftScopeKey,
  readDraft,
  writeDraft,
} from "../../../../src/plugins/project/composer/draftStore.ts";
import {
  prepareProjectDraft,
  projectDraftImageMigration,
  finishProjectDraftMigration,
} from "../../../../src/plugins/project/composer/projectDraftMigration.ts";

const project = "D:/migration-regression";
const scope = draftScopeKey(project, null, "A");
const fromA = legacyNewDraftScopeKey(project, "A");
const fromB = legacyNewDraftScopeKey(project, "B");
let drafts: ReturnType<typeof createAnnotationDraftStore>["service"];
beforeEach(() => {
  localStorage.clear();
  drafts = createAnnotationDraftStore(webviewStorage).service;
});
afterEach(() => vi.restoreAllMocks());

it("图片尚未加载时切换 Agent，迁移仍使用首次草稿来源", () => {
  writeDraft(fromA, "A 的当前草稿");
  writeDraft(fromB, "B 的过期副本");
  prepareProjectDraft(drafts, scope, fromA);
  prepareProjectDraft(drafts, scope, fromB);
  expect(readDraft(scope)).toBe("A 的当前草稿");
  expect(readDraft(fromA)).toBe("");
  const a = [
    {
      name: "A.png",
      block: { type: "image", data: "a", mimeType: "image/png" },
    },
  ];
  const b = [
    {
      name: "B.png",
      block: { type: "image", data: "b", mimeType: "image/png" },
    },
  ];
  const migrated = projectDraftImageMigration(scope, {
    [fromA]: a,
    [fromB]: b,
  });
  expect(migrated?.images[scope]).toEqual(a);
  expect(migrated?.images[fromA]).toBeUndefined();
  finishProjectDraftMigration(drafts, scope, fromA);
  prepareProjectDraft(drafts, scope, fromB);
  expect(readDraft(scope)).toBe("A 的当前草稿");
  expect(projectDraftImageMigration(scope, { [fromB]: b })).toBeNull();
});

it("新草稿落盘失败时保留旧文字，不提前标记迁移完成", () => {
  writeDraft(fromA, "不可丢失");
  const original = localStorage.setItem.bind(localStorage);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key: string,
    value: string,
  ) {
    if (key === scope) throw new Error("quota full");
    original(key, value);
  });
  prepareProjectDraft(drafts, scope, fromA);
  finishProjectDraftMigration(drafts, scope, fromA);
  expect(readDraft(fromA)).toBe("不可丢失");
  expect(readDraft(scope)).toBe("");
  expect(localStorage.getItem(`${scope}/project-draft-migration-v1`)).toBe(
    fromA,
  );
  vi.restoreAllMocks();
  prepareProjectDraft(drafts, scope, fromB);
  expect(readDraft(scope)).toBe("不可丢失");
  expect(readDraft(fromA)).toBe("");
});

it("重试迁移保留已编辑的项目文字与图片，不重复合并旧副本", () => {
  writeDraft(scope, "迁移后继续编辑的文字");
  writeDraft(fromA, "旧文字");
  prepareProjectDraft(drafts, scope, fromA);
  expect(readDraft(scope)).toBe("迁移后继续编辑的文字");
  const latest = [
    {
      name: "latest.png",
      block: { type: "image", data: "new", mimeType: "image/png" },
    },
  ];
  const old = [
    {
      name: "old.png",
      block: { type: "image", data: "old", mimeType: "image/png" },
    },
  ];
  expect(
    projectDraftImageMigration(scope, { [scope]: latest, [fromA]: old })
      ?.images[scope],
  ).toEqual(latest);
  expect(
    projectDraftImageMigration(scope, { [scope]: [], [fromA]: old })?.images[
      scope
    ],
  ).toEqual([]);
});
