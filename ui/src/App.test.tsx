import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { markdownPathForName, TagsView, ViewErrorBoundary } from "./App";
import type { ApiClient } from "./api";

describe("management UI regressions", () => {
  it("renders the real taxonomy response shape without blanking the view", async () => {
    const api: ApiClient = {
      get: vi.fn().mockResolvedValue({
        tags: [{ key: "wildlife", displayForms: ["Wildlife"], usageCount: 1, topics: ["penguins"] }],
        warnings: {
          singletonSummary: { count: 1, sampleKeys: ["wildlife"] },
          variants: [], comparisonCollisions: [], nearDuplicates: [],
          overGuidance: { count: 0, topics: [] }
        }
      }),
      send: vi.fn()
    };
    render(<TagsView api={api} />);
    expect(await screen.findByText("#Wildlife")).toBeInTheDocument();
    expect(screen.getByText("Singleton tags")).toBeInTheDocument();
    expect(screen.getByText("penguins")).toBeInTheDocument();
  });

  it("keeps navigation-safe UI around a failed view", () => {
    const Explodes = () => { throw new Error("Broken view fixture."); };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<ViewErrorBoundary resetKey="tags"><Explodes /></ViewErrorBoundary>);
    expect(screen.getByRole("heading", { name: "This view could not be shown" })).toBeInTheDocument();
    expect(screen.getByText(/Broken view fixture/)).toBeInTheDocument();
    error.mockRestore();
  });

  it("adds exactly one Markdown suffix to a name", () => {
    expect(markdownPathForName("research/observations")).toBe("research/observations.md");
    expect(markdownPathForName("research/observations.MD")).toBe("research/observations.md");
    expect(markdownPathForName("  note  ")).toBe("note.md");
  });
});
