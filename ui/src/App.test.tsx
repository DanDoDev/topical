import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { currentHistoryPath, fileUpdatedAtParts, loadTabSession, markdownPathForName, reorderDocumentTabs, reorderTopicGroups, SearchView, sortTopicFiles, TagsView, topicGroupTone, TopicCard, TopicWorkspace, ViewErrorBoundary } from "./App";
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

  it("uses the service fileCount and exposes tags as separate filters", () => {
    const open = vi.fn();
    const filter = vi.fn();
    render(<TopicCard topic={{ title: "Penguin notes", summary: "Colony observations.", tags: ["wildlife"], fileCount: 3, updatedAt: "2026-08-17T13:08:00.000Z" }} onOpen={open} onTagClick={filter} />);

    expect(screen.getByText(/3 files/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show topics tagged wildlife" }));
    expect(filter).toHaveBeenCalledWith("wildlife");
    expect(open).not.toHaveBeenCalled();
  });

  it("pins context and sorts supporting files without changing their metadata", () => {
    const files = [
      { path: "zeta.md", updatedAt: "2026-08-16T10:00:00.000Z" },
      { path: "context.md", updatedAt: "2026-08-10T10:00:00.000Z" },
      { path: "alpha.md", updatedAt: "2026-08-17T10:00:00.000Z" }
    ];
    expect(sortTopicFiles(files, "recent").map((file) => file.path)).toEqual(["context.md", "alpha.md", "zeta.md"]);
    expect(sortTopicFiles(files, "name").map((file) => file.path)).toEqual(["context.md", "alpha.md", "zeta.md"]);
    expect(sortTopicFiles(files.map((file, index) => ({ ...file, size: index })), "size").map((file) => file.path)).toEqual(["context.md", "alpha.md", "zeta.md"]);
    expect(files.map((file) => file.path)).toEqual(["zeta.md", "context.md", "alpha.md"]);
  });

  it("splits file update timestamps into visible date and time lines", () => {
    expect(fileUpdatedAtParts("2026-08-17T13:08:00.000Z")).toEqual({
      date: expect.stringMatching(/^August 17th, 2026$/),
      time: expect.stringMatching(/^\d{1,2}:08 [AP]M$/)
    });
    expect(fileUpdatedAtParts("not-a-date")).toEqual({ date: "Unknown date", time: undefined });
  });

  it("opens only history entries whose current file can exist", () => {
    expect(currentHistoryPath({ topic: "penguins", action: "update_file", path: "notes.md" })).toBe("notes.md");
    expect(currentHistoryPath({ topic: "penguins", action: "update_metadata" })).toBe("context.md");
    expect(currentHistoryPath({ topic: "penguins", action: "delete_file", path: "notes.md" })).toBeUndefined();
    expect(currentHistoryPath({ topic: "penguins", action: "delete_topic", path: "context.md" })).toBeUndefined();
  });

  it("reorders tabs within a topic and moves whole topic groups", () => {
    const tabs = [
      { key: "penguins\0context.md", topic: "penguins", path: "context.md", title: "Penguins" },
      { key: "penguins\0notes.md", topic: "penguins", path: "notes.md", title: "Penguins" },
      { key: "seals\0context.md", topic: "seals", path: "context.md", title: "Seals" }
    ];
    expect(reorderDocumentTabs(tabs, tabs[0].key, tabs[1].key).map((tab) => tab.path)).toEqual(["notes.md", "context.md", "context.md"]);
    expect(reorderDocumentTabs(tabs, tabs[0].key, tabs[2].key)).toBe(tabs);
    expect(reorderTopicGroups(tabs, "penguins", "seals").map((tab) => tab.topic)).toEqual(["seals", "penguins", "penguins"]);
  });

  it("restores more than twelve document tabs without truncating the session", () => {
    const tabs = Array.from({ length: 16 }, (_, index) => ({
      key: `penguins\0note-${index}.md`, topic: "penguins", path: `note-${index}.md`, title: "Penguins"
    }));
    window.sessionStorage.setItem("topical.document-tabs.v1", JSON.stringify({ tabs, active: tabs[15].key, collapsedTopics: [] }));

    const restored = loadTabSession();

    expect(restored.tabs).toHaveLength(16);
    expect(restored.active).toBe(tabs[15].key);
    window.sessionStorage.clear();
  });

  it("assigns stable topic-group tones", () => {
    expect(topicGroupTone("penguins")).toBe(topicGroupTone("penguins"));
    expect(topicGroupTone("penguins")).not.toBe(topicGroupTone("seals"));
    expect(topicGroupTone("penguins")).toBeGreaterThanOrEqual(0);
    expect(topicGroupTone("penguins")).toBeLessThan(8);
  });

  it("loads the selected file once and keeps the complete file browser lazy", async () => {
    const get = vi.fn(async (requestPath: string) => {
      if (requestPath.startsWith("/revision")) return { revision: "topic-r1" };
      if (requestPath.startsWith("/topics/fixture/overview")) return {
        topic: "fixture",
        metadata: { id: "fixture", title: "Fixture topic", summary: "Bounded workspace.", tags: [] },
        files: [{ path: "context.md", hash: "a".repeat(64), size: 20, headings: ["Fixture"], updatedAt: "2026-08-22T10:00:00.000Z" }],
        filePage: { limit: 12, total: 2, nextCursor: "more" }
      };
      if (requestPath.startsWith("/topic-files")) return { files: [{ path: "context.md", hash: "a".repeat(64), size: 20, headings: ["Fixture"], updatedAt: "2026-08-22T10:00:00.000Z" }, { path: "notes/deep.md", hash: "b".repeat(64), size: 42, headings: ["Deep note"], updatedAt: "2026-08-21T10:00:00.000Z" }], page: { limit: 50, total: 2, nextCursor: null } };
      if (requestPath.startsWith("/topic-file")) return { topic: "fixture", path: "context.md", content: "# Fixture\n", hash: "a".repeat(64) };
      if (requestPath.startsWith("/history")) return { events: [], page: { limit: 8, total: 0, nextCursor: null } };
      throw new Error(`Unexpected request: ${requestPath}`);
    });
    const api: ApiClient = { get: get as ApiClient["get"], send: vi.fn() };
    const props = { api, topic: "fixture", path: "context.md", onBack: vi.fn(), onChanged: vi.fn(), onDirtyChange: vi.fn(), onOpenDocument: vi.fn(), onDeletedFile: vi.fn(), onDeletedTopic: vi.fn(), onTagClick: vi.fn() };
    const view = render(<TopicWorkspace {...props} />);
    expect(await screen.findByRole("heading", { name: "Fixture topic" })).toBeInTheDocument();
    await waitFor(() => expect(get.mock.calls.filter(([requestPath]) => String(requestPath).startsWith("/topic-file?")).length).toBe(1));
    expect(get.mock.calls.some(([requestPath]) => String(requestPath).startsWith("/topic-files?"))).toBe(false);
    expect(get.mock.calls.some(([requestPath]) => String(requestPath).startsWith("/history"))).toBe(false);
    expect(screen.getByRole("region", { name: "Topic files" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("button", { name: "Files" })).toHaveAttribute("aria-haspopup", "dialog");

    fireEvent.click(screen.getByRole("tab", { name: "Change history" }));
    await waitFor(() => expect(get.mock.calls.some(([requestPath]) => String(requestPath).startsWith("/history"))).toBe(true));
    expect(screen.getByRole("region", { name: "Recent topic changes" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("button", { name: "Show all history" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Collapse topic browser" }));
    expect(screen.queryByRole("region", { name: "Recent topic changes" })).not.toBeInTheDocument();
    expect(screen.getByText("File hash")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /Files 2/ }));

    fireEvent.click(screen.getByRole("button", { name: "Show all 2 files" }));
    expect(await screen.findByRole("heading", { name: "All files in Fixture topic" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Topic file results" })).toHaveAttribute("tabindex", "0");
    expect(await screen.findByText("notes/deep.md")).toBeInTheDocument();
    expect(get.mock.calls.some(([requestPath]) => String(requestPath).startsWith("/topic-files?"))).toBe(true);
    view.unmount();
  });

  it("shows each matching file as an exact search destination and lazily reveals the rest", async () => {
    const get = vi.fn(async (requestPath: string) => {
      if (requestPath.startsWith("/search/files")) return {
        files: [
          { path: "one.md", snippet: "First exact match.", matchedTerms: ["narwhal"] },
          { path: "two.md", snippet: "Second exact match.", matchedTerms: ["narwhal"] },
          { path: "three.md", snippet: "Third exact match.", matchedTerms: ["narwhal"] },
          { path: "deep/four.md", snippet: "Fourth exact match.", matchedTerms: ["narwhal"] }
        ],
        page: { limit: 50, total: 4, nextCursor: null }
      };
      if (requestPath.startsWith("/search")) return {
        matchMode: "strict", analysis: { ignoredTerms: [] }, topics: [{ topic: "ocean", title: "Ocean notes", summary: "Marine research.", tags: [], matchedFields: ["body"], fileMatchCount: 4, files: [{ path: "one.md", snippet: "First exact match.", matchedTerms: ["narwhal"] }, { path: "two.md", snippet: "Second exact match.", matchedTerms: ["narwhal"] }, { path: "three.md", snippet: "Third exact match.", matchedTerms: ["narwhal"] }] }]
      };
      throw new Error(`Unexpected request: ${requestPath}`);
    });
    const open = vi.fn();
    render(<SearchView api={{ get: get as ApiClient["get"], send: vi.fn() }} onOpen={open} onTagClick={vi.fn()} request={{ query: "narwhal", key: 1 }} liveRevision={0} />);
    expect(await screen.findByText("three.md")).toBeInTheDocument();
    fireEvent.click(screen.getByText("two.md"));
    expect(open).toHaveBeenCalledWith("ocean", "two.md", "Ocean notes");
    expect(get.mock.calls.filter(([requestPath]) => String(requestPath).startsWith("/search/files")).length).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Show all 4 matching files" }));
    expect(await screen.findByText("deep/four.md")).toBeInTheDocument();
    fireEvent.click(screen.getByText("deep/four.md"));
    expect(open).toHaveBeenCalledWith("ocean", "deep/four.md", "Ocean notes");
  });
});
