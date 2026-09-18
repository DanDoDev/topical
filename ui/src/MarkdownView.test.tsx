import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MarkdownView, resolveTopicLink } from "./MarkdownView";

afterEach(cleanup);

describe("MarkdownView", () => {
  it("opens relative Markdown links within the topic and hides task metadata", () => {
    const onOpenFile = vi.fn();
    const { container } = render(<MarkdownView currentPath="issues/a/context.md" onOpenFile={onOpenFile}>{"<!-- topical:tasks off -->\n\n[Runbook](drafts/runbook.md)"}</MarkdownView>);
    fireEvent.click(screen.getByRole("link", { name: "Runbook" }));
    expect(onOpenFile).toHaveBeenCalledWith("issues/a/drafts/runbook.md");
    expect(container).not.toHaveTextContent("topical:tasks");
    expect(resolveTopicLink("../../context.md", "issues/a/context.md")).toBe("context.md");
    for (const href of ["../../../secret.md", "https://example.com/a.md", "//example.com/a.md", "%2fetc/a.md", "javascript:alert(1)"]) expect(resolveTopicLink(href, "issues/a/context.md")).toBeNull();
  });
  it("renders useful Markdown while leaving embedded HTML inert", () => {
    const { container } = render(<MarkdownView>{"# Safe\n\n- [x] done\n\n<script>alert(1)</script>"}</MarkdownView>);
    expect(screen.getByRole("heading", { name: "Safe" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(container.querySelector("script")).toBeNull();
    expect(container).toHaveTextContent("<script>alert(1)</script>");
  });

  it("keeps topic frontmatter out of reading and preview surfaces", () => {
    render(<MarkdownView>{"---\ntitle: Secret plumbing\ntags: [ui]\n---\n# Visible body"}</MarkdownView>);
    expect(screen.getByRole("heading", { name: "Visible body" })).toBeInTheDocument();
    expect(screen.queryByText(/Secret plumbing/)).not.toBeInTheDocument();
  });

  it("does not preserve unsafe link schemes", () => {
    const { container } = render(<MarkdownView>{"[unsafe](javascript:alert(1))"}</MarkdownView>);
    expect(container.querySelector("a")).not.toHaveAttribute("href", expect.stringContaining("javascript:"));
  });
});
