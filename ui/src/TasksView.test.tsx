import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TasksView } from "./TasksView";
import { WorkAreaForm } from "./WorkAreaForm";

const task = { topic: "orbit", topicTitle: "Orbit", path: "issues/a/context.md", sourceHash: "a".repeat(64), offset: 14, line: 3, text: "Verify backups", heading: "Actions", completed: false };
const page = { tasks: [task], counts: { open: 1, completed: 0, total: 1, topics: 1 }, page: { total: 1, nextCursor: null } };
afterEach(cleanup);

describe("indexed tasks", () => {
  it("completes using the reviewed source location and opens the owning file", async () => {
    const api = { get: vi.fn().mockResolvedValue(page), send: vi.fn().mockResolvedValue({}) };
    const onOpen = vi.fn();
    render(<TasksView api={api} initialTopic="orbit" initialPath="issues/a" onOpen={onOpen} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open source" }));
    expect(onOpen).toHaveBeenCalledWith("orbit", task.path, "Orbit");
    fireEvent.click(screen.getByRole("checkbox", { name: "Complete: Verify backups" }));
    await waitFor(() => expect(api.send).toHaveBeenCalledWith("PATCH", "/task", expect.objectContaining({ filePath: task.path, offset: 14, expectedHash: task.sourceHash, completed: true })));
    expect(api.get.mock.calls.some(([url]) => url.includes("pathPrefix=issues%2Fa"))).toBe(true);
  });

  it("shows conflicts without silently retrying task edits", async () => {
    const api = { get: vi.fn().mockResolvedValue(page), send: vi.fn().mockRejectedValue(new Error("The reviewed content changed.")) };
    render(<TasksView api={api} onOpen={() => {}} />);
    fireEvent.click(await screen.findByRole("checkbox"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Refresh and review");
    expect(api.send).toHaveBeenCalledTimes(1);
  });

  it("reviews parent context before linked work creation", async () => {
    const api = { get: vi.fn().mockResolvedValue({ hash: task.sourceHash, content: "# Parent" }), send: vi.fn().mockResolvedValue({ path: "issues/test/context.md" }) };
    const onCreated = vi.fn();
    render(<WorkAreaForm api={api} topic="orbit" parentFile="context.md" onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Test issue" } });
    fireEvent.change(screen.getByLabelText("Folder or document name"), { target: { value: "test" } });
    fireEvent.change(screen.getByLabelText("Change description"), { target: { value: "Track the test issue." } });
    fireEvent.click(screen.getByRole("button", { name: "Review parent context" }));
    expect(await screen.findByText("# Parent")).toBeVisible();
    expect(api.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Create and link work" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("issues/test/context.md"));
    expect(api.send).toHaveBeenCalledWith("POST", "/work-areas", expect.objectContaining({ expectedHash: task.sourceHash, parentFile: "context.md" }));
  });
});
