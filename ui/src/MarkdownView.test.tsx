import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MarkdownView } from "./MarkdownView";

describe("MarkdownView", () => {
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
