import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";

import { MarkdownView } from "./MarkdownView.js";

afterEach(cleanup);

describe("MarkdownView", () => {
  it("renders useful Markdown while leaving embedded HTML inert", () => {
    const { container } = render(<MarkdownView>{"# Safe\n\n- [x] done\n\n<script>alert(1)</script>"}</MarkdownView>);
    assert.ok(screen.getByRole("heading", { name: "Safe" }));
    assert.equal((screen.getByRole("checkbox") as HTMLInputElement).disabled, true);
    assert.equal(container.querySelector("script"), null);
    assert.match(container.textContent ?? "", /<script>alert\(1\)<\/script>/);
  });

  it("keeps topic frontmatter out of reading and preview surfaces", () => {
    render(<MarkdownView>{"---\ntitle: Secret plumbing\ntags: [ui]\n---\n# Visible body"}</MarkdownView>);
    assert.ok(screen.getByRole("heading", { name: "Visible body" }));
    assert.equal(screen.queryByText(/Secret plumbing/), null);
  });

  it("does not preserve unsafe link schemes", () => {
    const { container } = render(<MarkdownView>{"[unsafe](javascript:alert(1))"}</MarkdownView>);
    assert.doesNotMatch(container.querySelector("a")?.getAttribute("href") ?? "", /javascript:/i);
  });
});
