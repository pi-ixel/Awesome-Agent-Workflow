import { expect, it } from "vitest";
import { memoryToolIO } from "../../../src/plugins/tools/runtime/io.ts";

it("writes relative tool paths and exposes each parent directory", async () => {
  const io = memoryToolIO();
  await io.writeTextFile("tools/projects/u1/demo/index.html", "<p>test</p>");
  expect(await io.readTextFile("tools/projects/u1/demo/index.html")).toBe("<p>test</p>");
  expect(await io.pathExists("tools")).toBe(true);
  expect(await io.listDirNames("tools/projects/u1")).toEqual(["demo"]);
});

it("terminates at bare filenames and absolute path roots", async () => {
  const io = memoryToolIO();
  for (const path of ["notes.txt", "/data/tools/index.html", "C:\\data\\tools\\index.html"]) {
    await io.writeTextFile(path, path);
    expect(await io.readTextFile(path)).toBe(path);
  }
  expect(await io.pathExists("/data/tools")).toBe(true);
  expect(await io.pathExists("C:\\data\\tools")).toBe(true);
});
