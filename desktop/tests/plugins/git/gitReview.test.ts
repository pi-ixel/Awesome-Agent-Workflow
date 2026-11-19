import type { GitChange, GitDiff } from "../../../src/plugins/host/types.ts";
import { describe, expect, it, vi } from "vitest";
import {
  changeKey,
  findReviewMatches,
  reviewModel,
} from "../../../src/plugins/git/review/review.ts";
import { createGitDiffCache } from "../../../src/plugins/git/diff/diffCache.ts";

const changed: GitDiff = {
  patch:
    "diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -2,2 +2,2 @@\n-old\n+new new\n same\n",
  beforeContent: "hidden\nold\nsame\ntail\n",
  afterContent: "hidden\nnew new\nsame\ntail\n",
  notice: null,
};
const change = (index: number): GitChange => ({
  path: `${index}.txt`,
  oldPath: null,
  status: "修改",
  source: "unstaged",
});

describe("Git 内容查找", () => {
  it("查找折叠上下文、分别统计两侧，跳过文件头；多次命中按出现次数计数", () => {
    const model = reviewModel(changed);
    expect(model.full).toBe(true);
    expect(model.rows[0]).toMatchObject({ hidden: true, old: 1, next: 1 });
    expect(
      findReviewMatches("key", model, " HIDDEN ").map((hit) => hit.side),
    ).toEqual(["old", "next"]);
    expect(findReviewMatches("key", model, "new")).toHaveLength(2);
    expect(findReviewMatches("key", model, "file")).toHaveLength(0);
    expect(findReviewMatches("key", model, "")).toEqual([]);
  });
  it("读取之间内容变化或全文不可用时回退 patch，不制造缺失的旧文件", () => {
    const model = reviewModel({ ...changed, beforeContent: "raced\n" });
    expect(model.full).toBe(false);
    expect(findReviewMatches("key", model, "same")).toHaveLength(1);
    expect(findReviewMatches("key", model, "hidden")).toHaveLength(0);
    expect(reviewModel({ ...changed, beforeContent: null }).full).toBe(false);
  });
  it("兼容 Windows 换行、纯重命名、整文件新增与删除", () => {
    expect(
      reviewModel({
        ...changed,
        afterContent: changed.afterContent?.replaceAll("\n", "\r\n"),
      }).full,
    ).toBe(true);
    const rename = reviewModel({
      patch:
        "diff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new",
      beforeContent: "same\n",
      afterContent: "same\n",
      notice: null,
    });
    expect(rename.full).toBe(true);
    expect(findReviewMatches("key", rename, "same")).toHaveLength(2);
    expect(
      reviewModel({
        patch: "@@ -0,0 +1 @@\n+new",
        beforeContent: "",
        afterContent: "new",
        notice: null,
      }).full,
    ).toBe(true);
    expect(
      reviewModel({
        patch: "@@ -1 +0,0 @@\n-old",
        beforeContent: "old",
        afterContent: "",
        notice: null,
      }).full,
    ).toBe(true);
  });
});

describe("Git Diff 有界队列", () => {
  it("并发至多四个、重复请求去重、切换来源丢掉等待队列", async () => {
    const finish: ((data: GitDiff) => void)[] = [];
    const read = vi.fn(
      () => new Promise<GitDiff>((resolve) => finish.push(resolve)),
    );
    const cache = createGitDiffCache(read);
    cache.request(Array.from({ length: 10 }, (_, index) => change(index)));
    expect(read).toHaveBeenCalledTimes(4);
    cache.request([change(0), change(20)]);
    finish[0]?.(changed);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(5));
    expect(read.mock.calls.at(-1)).toEqual([change(20)]);
    expect(cache.getSnapshot()[changeKey(change(0))]?.model?.full).toBe(true);
    cache.dispose();
    finish.slice(1).forEach((resolve) => resolve(changed));
    await Promise.resolve();
    expect(cache.getSnapshot()[changeKey(change(1))]?.data).toBeUndefined();
  });
  it("StrictMode 重放不终止缓存，真正卸载不发布迟到数据", async () => {
    let finish: ((data: GitDiff) => void) | undefined;
    const cache = createGitDiffCache(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const release = cache.retain();
    release();
    const releaseAgain = cache.retain();
    await Promise.resolve();
    cache.request([change(0)]);
    expect(finish).toBeDefined();
    const listener = vi.fn();
    cache.subscribe(listener);
    releaseAgain();
    await Promise.resolve();
    finish?.(changed);
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
  });
});
