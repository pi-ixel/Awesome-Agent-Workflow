/**
 * ColumnResizer 测试：拖拽更新 CSS 变量并持久化、双击复位默认宽、
 * 持久化栏宽的首帧恢复（applyPersistedColumnWidths）。
 *
 * jsdom 无真实布局：拖拽经 pointer 事件序列模拟（clientX 由事件对象
 * 携带），断言落在根元素的内联 CSS 变量与 localStorage 上。
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import {
  clampWidth,
  applyPersistedColumnWidths,
  LEFT_DEFAULT_PX,
  LEFT_MAX_PX,
  LEFT_MIN_PX,
  LEFT_WIDTH_STORAGE_KEY,
  LEFT_WIDTH_VAR,
} from "../../src/ui/workbench/columnWidths.ts";
import { ColumnResizer } from "../../src/ui/workbench/ColumnResizer.tsx";

/** 「growDirection=start」方向测试用的就地常量（右栏已退役，
 *  组件本身仍是方向无关的通用分隔线）。 */
const START_WIDTH_VAR = "--test-start-w";
const START_WIDTH_STORAGE_KEY = "test/layout/start-w";
const START_DEFAULT_PX = 340;
const START_MIN_PX = 240;
const START_MAX_PX = 520;

/** 读根元素内联 CSS 变量值。 */
function readVar(cssVarName: string): string {
  return document.documentElement.style.getPropertyValue(cssVarName);
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.style.removeProperty(LEFT_WIDTH_VAR);
  document.documentElement.style.removeProperty(START_WIDTH_VAR);
  document.body.style.removeProperty("user-select");
});

describe("ColumnResizer", () => {
  it("拖拽左栏分隔线：向右拖增宽，写入 CSS 变量并持久化", () => {
    render(
      <ColumnResizer
        cssVarName={LEFT_WIDTH_VAR}
        storageKey={LEFT_WIDTH_STORAGE_KEY}
        defaultWidthPx={LEFT_DEFAULT_PX}
        minPx={LEFT_MIN_PX}
        maxPx={LEFT_MAX_PX}
        growDirection="end"
        label="调整左栏宽度"
      />,
    );
    const resizer = screen.getByRole("separator", { name: "调整左栏宽度" });

    fireEvent.pointerDown(resizer, { button: 0, clientX: 500 });
    // 拖拽期间禁文字划选
    expect(document.body.style.getPropertyValue("user-select")).toBe("none");
    fireEvent.pointerMove(window, { clientX: 560 });
    fireEvent.pointerUp(window);

    expect(readVar(LEFT_WIDTH_VAR)).toBe("324px");
    expect(window.localStorage.getItem(LEFT_WIDTH_STORAGE_KEY)).toBe("324");
    // 收口后解除禁划选
    expect(document.body.style.getPropertyValue("user-select")).toBe("");
  });

  it("拖拽 start 方向分隔线：向左拖增宽，并钳制在上限", () => {
    render(
      <ColumnResizer
        cssVarName={START_WIDTH_VAR}
        storageKey={START_WIDTH_STORAGE_KEY}
        defaultWidthPx={START_DEFAULT_PX}
        minPx={START_MIN_PX}
        maxPx={START_MAX_PX}
        growDirection="start"
        label="调整 start 方向分隔线"
      />,
    );
    const resizer = screen.getByRole("separator", {
      name: "调整 start 方向分隔线",
    });

    fireEvent.pointerDown(resizer, { button: 0, clientX: 900 });
    // 向左拖 800px：远超上限，钳制在上限
    fireEvent.pointerMove(window, { clientX: 100 });
    fireEvent.pointerUp(window);

    expect(readVar(START_WIDTH_VAR)).toBe(`${START_MAX_PX}px`);
    expect(window.localStorage.getItem(START_WIDTH_STORAGE_KEY)).toBe(
      String(START_MAX_PX),
    );
  });

  it("拖拽位移映射到左栏：向左拖收窄，且不低于下限", () => {
    render(
      <ColumnResizer
        cssVarName={LEFT_WIDTH_VAR}
        storageKey={LEFT_WIDTH_STORAGE_KEY}
        defaultWidthPx={LEFT_DEFAULT_PX}
        minPx={LEFT_MIN_PX}
        maxPx={LEFT_MAX_PX}
        growDirection="end"
        label="调整左栏宽度"
      />,
    );
    const resizer = screen.getByRole("separator", { name: "调整左栏宽度" });

    fireEvent.pointerDown(resizer, { button: 0, clientX: 500 });
    // 向左拖 400px：低于下限 200，钳制在下限
    fireEvent.pointerMove(window, { clientX: 100 });
    fireEvent.pointerUp(window);

    expect(readVar(LEFT_WIDTH_VAR)).toBe(`${LEFT_MIN_PX}px`);
    expect(window.localStorage.getItem(LEFT_WIDTH_STORAGE_KEY)).toBe(
      String(LEFT_MIN_PX),
    );
  });

  it("双击复位默认宽度并持久化", () => {
    window.localStorage.setItem(LEFT_WIDTH_STORAGE_KEY, "400");
    render(
      <ColumnResizer
        cssVarName={LEFT_WIDTH_VAR}
        storageKey={LEFT_WIDTH_STORAGE_KEY}
        defaultWidthPx={LEFT_DEFAULT_PX}
        minPx={LEFT_MIN_PX}
        maxPx={LEFT_MAX_PX}
        growDirection="end"
        label="调整左栏宽度"
      />,
    );
    const resizer = screen.getByRole("separator", { name: "调整左栏宽度" });
    fireEvent.dblClick(resizer);

    expect(readVar(LEFT_WIDTH_VAR)).toBe(`${LEFT_DEFAULT_PX}px`);
    expect(window.localStorage.getItem(LEFT_WIDTH_STORAGE_KEY)).toBe(
      String(LEFT_DEFAULT_PX),
    );
  });

  it("applyPersistedColumnWidths：启动前恢复持久化栏宽，越界值钳制", () => {
    window.localStorage.setItem(LEFT_WIDTH_STORAGE_KEY, "9999");
    applyPersistedColumnWidths();

    expect(readVar(LEFT_WIDTH_VAR)).toBe(
      `${Math.max(LEFT_MIN_PX, window.innerWidth * 0.5)}px`,
    );
  });

  it("clampWidth：钳制进区间并取整", () => {
    expect(clampWidth(150, LEFT_MIN_PX, LEFT_MAX_PX)).toBe(LEFT_MIN_PX);
    expect(clampWidth(999.4, LEFT_MIN_PX, LEFT_MAX_PX)).toBe(LEFT_MAX_PX);
    expect(clampWidth(300.6, LEFT_MIN_PX, LEFT_MAX_PX)).toBe(301);
  });
});
