import { FormEvent, useState } from "react";
import { ApiClient, queryString } from "./api";

export function WorkAreaForm({ api, topic, parentFile: initialParentFile, onCreated }: { api: ApiClient; topic: string; parentFile: string; onCreated(path: string): void }) {
  const [parentFile, setParentFile] = useState(initialParentFile.endsWith("context.md") ? initialParentFile : "context.md");
  const [kind, setKind] = useState("issue");
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [brief, setBrief] = useState("");
  const [description, setDescription] = useState("");
  const [review, setReview] = useState<{ hash: string; content: string }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const prefix = parentFile.includes("/") ? parentFile.slice(0, parentFile.lastIndexOf("/") + 1) : "";
  const filePath = `${prefix}${kind === "draft" ? `drafts/${slug}.md` : `${kind === "issue" ? "issues" : "plans"}/${slug}/context.md`}`;
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      if (!review) {
        setReview(await api.get(`/topic-file${queryString({ topic, path: parentFile })}`));
      } else {
        const result = await api.send<{ path: string }>("POST", "/work-areas", { topic, kind, title, slug, brief, parentFile, expectedHash: review.hash, description });
        onCreated(result.path);
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Creation failed."); setReview(undefined); }
    finally { setBusy(false); }
  }
  return <form className="form-stack" onSubmit={submit}>
    <label>Parent context file<input required value={parentFile} onChange={(event) => { setParentFile(event.target.value); setReview(undefined); }} /></label>
    <label>Work type<select value={kind} onChange={(event) => { setKind(event.target.value); setReview(undefined); }}><option value="issue">Issue</option><option value="plan">Plan</option><option value="draft">Draft document</option></select></label>
    <label>Title<input required maxLength={160} value={title} onChange={(event) => { setTitle(event.target.value); setReview(undefined); }} /></label>
    <label>Folder or document name<input required maxLength={100} pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="inc-042-api-timeouts" value={slug} onChange={(event) => { setSlug(event.target.value); setReview(undefined); }} /></label>
    <div className="path-preview"><span>Will create</span><code>{filePath}</code></div>
    <label>Brief<textarea maxLength={4000} value={brief} onChange={(event) => { setBrief(event.target.value); setReview(undefined); }} /></label>
    <p>A link will be added to {parentFile}. {kind === "draft" && "Draft checklists are excluded from Tasks; keep authoring actions in the parent context."}</p>
    <label>Change description<input required minLength={3} maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
    {review && <details open><summary>Parent context to update</summary><pre className="workflow-parent-preview">{review.content}</pre></details>}
    {error && <p role="alert" className="notice error">{error}</p>}
    <div className="dialog-actions"><button className="primary" disabled={busy}>{busy ? "Working…" : review ? "Create and link work" : "Review parent context"}</button></div>
  </form>;
}
