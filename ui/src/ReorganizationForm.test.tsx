import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ReorganizationForm } from "./ReorganizationForm";
const analysis = { context: { hash: "a".repeat(64) }, sections: [{ start: 10, title: "Investigation", line: 3, characters: 400 }], findings: [] };
const preview = { previewHash: "b".repeat(64), source: { before: "Original evidence", after: "Linked evidence" }, files: [{ path: "history/evidence.md", content: "Preserved evidence" }], summary: { beforeCharacters: 500, afterCharacters: 100 } };
afterEach(cleanup);
async function select() {
  fireEvent.click(await screen.findByRole("checkbox"));
  fireEvent.change(screen.getByLabelText("Destination for Investigation"), { target: { value: "history/evidence.md" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
  await screen.findByRole("region", { name: "Reorganization preview" });
}
it("requires a preview and binds apply to the exact selected source and reviewed content", async () => {
  const api = { get: vi.fn().mockResolvedValue(analysis), send: vi.fn().mockResolvedValue(preview) };
  const done = vi.fn();
  render(<ReorganizationForm api={api} topic="orbit" filePath="context.md" onApplied={done} />);
  await select();
  expect(api.send).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Preserved evidence")).toBeVisible();
  fireEvent.change(screen.getByLabelText("Change description"), { target: { value: "Preserve evidence." } });
  fireEvent.click(screen.getByRole("button", { name: "Apply reviewed changes" }));
  await waitFor(() => expect(done).toHaveBeenCalled());
  expect(api.send).toHaveBeenLastCalledWith("POST", "/reorganization/apply", expect.objectContaining({ expectedHash: analysis.context.hash, previewHash: preview.previewHash, extractions: [{ start: 10, destination: "history/evidence.md" }] }));
});
it("invalidates the preview when destinations change", async () => {
  const api = { get: vi.fn().mockResolvedValue(analysis), send: vi.fn().mockResolvedValue(preview) };
  render(<ReorganizationForm api={api} topic="orbit" filePath="context.md" onApplied={() => {}} />);
  await select();
  fireEvent.change(screen.getByLabelText("Destination for Investigation"), { target: { value: "other.md" } });
  expect(screen.queryByRole("button", { name: "Apply reviewed changes" })).toBeNull();
  expect(screen.getByRole("button", { name: "Preview changes" })).toBeEnabled();
});
it("shows conflicts without retrying or silently refreshing the source hash", async () => {
  const api = { get: vi.fn().mockResolvedValue(analysis), send: vi.fn().mockResolvedValueOnce(preview).mockRejectedValueOnce(new Error("Source changed. Refresh and review.")) };
  render(<ReorganizationForm api={api} topic="orbit" filePath="context.md" onApplied={() => {}} />);
  await select();
  fireEvent.change(screen.getByLabelText("Change description"), { target: { value: "Preserve evidence." } });
  fireEvent.click(screen.getByRole("button", { name: "Apply reviewed changes" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Source changed");
  expect(api.send).toHaveBeenCalledTimes(2);
  expect(api.get).toHaveBeenCalledTimes(1);
});
