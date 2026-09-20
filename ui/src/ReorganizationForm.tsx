import { FormEvent, useEffect, useState } from "react";
import { ApiClient, ApiError, queryString } from "./api";

type Section = { start: number; line: number; title: string; characters: number };
type Analysis = { context: { hash: string }; sections: Section[]; sectionsTruncated: boolean; findings: { code: string; message: string }[] };
type Preview = { previewHash: string; source: { before: string; after: string }; files: { path: string; content: string }[]; summary: { beforeCharacters: number; afterCharacters: number } };
export function ReorganizationForm({ api, topic, filePath, onApplied }: { api: ApiClient; topic: string; filePath: string; onApplied(): void }) {
  const [analysis, setAnalysis] = useState<Analysis>();
  const [selected, setSelected] = useState<Record<number, string>>({});
  const [preview, setPreview] = useState<Preview>();
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setAnalysis(undefined); setPreview(undefined); setSelected({});
    api.get<Analysis>(`/topics/${encodeURIComponent(topic)}/context-analysis${queryString({ filePath })}`).then((value) => { if (active) setAnalysis(value); }).catch((reason) => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [api, topic, filePath, reload]);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!analysis) return;
    setBusy(true); setError("");
    const input = { topic, filePath, expectedHash: analysis.context.hash, extractions: Object.entries(selected).map(([start, destination]) => ({ start: Number(start), destination })) };
    try {
      if (!preview) setPreview(await api.send<Preview>("POST", "/reorganization/preview", input));
      else { await api.send("POST", "/reorganization/apply", { ...input, previewHash: preview.previewHash, description }); onApplied(); }
    } catch (reason) {
      let message = reason instanceof Error ? reason.message : "Reorganization failed.";
      if (reason instanceof ApiError && reason.code === "PARTIAL_REORGANIZATION") {
        const details = reason.details as { preserved?: string[]; sourceWritten?: boolean };
        message += ` Preserved files: ${details?.preserved?.join(", ") || "none reported"}. Source updated: ${details?.sourceWritten ? "yes; reindex before continuing" : "no"}.`;
      }
      setError(message); setPreview(undefined);
    }
    finally { setBusy(false); }
  }
  return <form className="form-stack" onSubmit={submit}>
    <p>Move selected sections from {filePath} into supporting files. Review the exact changes before applying. Headings remain as links; TODOs move with their section.</p>
    {!analysis && !error && <p role="status">Analyzing context…</p>}
    {analysis?.findings.map((finding) => <p key={finding.code} className="notice">{finding.message}</p>)}
    {analysis && !analysis.sections.length && <p>No extractable sections. Add a level 2–6 heading around the material you want to organize.</p>}
    {analysis?.sectionsTruncated && <p>Showing the first 100 sections. Organize these first or select a smaller supporting file.</p>}
    <fieldset disabled={busy} className="form-stack"><legend>Sections to extract</legend>
      {analysis?.sections.map((section) => <div key={section.start}>
        <label className="reorganization-section"><input type="checkbox" checked={section.start in selected} onChange={(event) => {
          setPreview(undefined);
          setSelected((current) => { const next = { ...current }; if (event.target.checked) next[section.start] = ""; else delete next[section.start]; return next; });
        }} />{section.title} — line {section.line}, {section.characters.toLocaleString()} characters</label>
        {section.start in selected && <label>Destination for {section.title}<input required placeholder="history/investigation.md" value={selected[section.start]} onChange={(event) => { setSelected({ ...selected, [section.start]: event.target.value }); setPreview(undefined); }} /></label>}
      </div>)}
    </fieldset>
    <p>Destination paths are relative to the topic root. Select a parent section or its children, not both.</p>
    {preview && <section aria-label="Reorganization preview">
      <p>Source: {preview.summary.beforeCharacters.toLocaleString()} → {preview.summary.afterCharacters.toLocaleString()} characters.</p>
      <details><summary>Source before</summary><pre className="workflow-parent-preview">{preview.source.before}</pre></details>
      <details open><summary>Source after</summary><pre className="workflow-parent-preview">{preview.source.after}</pre></details>
      {preview.files.map((file) => <details open key={file.path}><summary>Supporting file: {file.path}</summary><pre className="workflow-parent-preview">{file.content}</pre></details>)}
      <label>Change description<input required minLength={3} maxLength={500} disabled={busy} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
    </section>}
    {error && <p role="alert" className="notice error">{error} Read the affected files before retrying after a partial failure.</p>}
    <div className="dialog-actions"><button type="button" disabled={busy} onClick={() => { setError(""); setReload((value) => value + 1); }}>Refresh analysis</button><button className="primary" disabled={busy || !analysis || !Object.keys(selected).length}>{busy ? "Working…" : preview ? "Apply reviewed changes" : "Preview changes"}</button></div>
  </form>;
}
