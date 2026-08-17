import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";

import { markdownPathForName, TagsView, ViewErrorBoundary } from "./App.js";
import type { ApiClient } from "./api.js";

afterEach(cleanup);

describe("management UI regressions", () => {
  it("renders the real taxonomy response shape without blanking the view", async () => {
    const api: ApiClient = {
      get: async <T,>() => ({
        tags: [{ key: "wildlife", displayForms: ["Wildlife"], usageCount: 1, topics: ["penguins"] }],
        warnings: {
          singletonSummary: { count: 1, sampleKeys: ["wildlife"] },
          variants: [], comparisonCollisions: [], nearDuplicates: [],
          overGuidance: { count: 0, topics: [] }
        }
      }) as T,
      send: async <T,>() => ({}) as T
    };
    render(<TagsView api={api} />);
    assert.ok(await screen.findByText("#Wildlife"));
    assert.ok(screen.getByText("Singleton tags"));
    assert.ok(screen.getByText("penguins"));
  });

  it("keeps navigation-safe UI around a failed view", () => {
    const Explodes = () => { throw new Error("Broken view fixture."); };
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      render(<ViewErrorBoundary resetKey="tags"><Explodes /></ViewErrorBoundary>);
      assert.ok(screen.getByRole("heading", { name: "This view could not be shown" }));
      assert.ok(screen.getByText(/Broken view fixture/));
    } finally {
      console.error = originalConsoleError;
    }
  });

  it("adds exactly one Markdown suffix to a name", () => {
    assert.equal(markdownPathForName("research/observations"), "research/observations.md");
    assert.equal(markdownPathForName("research/observations.MD"), "research/observations.md");
    assert.equal(markdownPathForName("  note  "), "note.md");
  });
});
