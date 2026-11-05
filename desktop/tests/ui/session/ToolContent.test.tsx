import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ToolContent } from "../../../src/ui/session/ToolContent.tsx";

describe("standard ACP tool content", () => {
  it("renders text without rawOutput or agent metadata", () => {
    render(
      <ToolContent
        content={[
          {
            type: "content",
            content: { type: "text", text: "standard output" },
          },
        ]}
      />,
    );
    expect(screen.getByText("standard output")).toBeInTheDocument();
  });
  it("keeps unknown blocks visible instead of discarding them", () => {
    render(
      <ToolContent content={[{ type: "future", payload: "preserved" }]} />,
    );
    expect(screen.getByText(/preserved/)).toBeInTheDocument();
  });
});
