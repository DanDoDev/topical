import { FormEvent, lazy, ReactNode, Suspense, useEffect, useState } from "react";

import { ApiClient, ApiError, connectApi, queryString } from "./api";
import { MarkdownView } from "./MarkdownView";

const MarkdownEditor = lazy(() => import("./MarkdownEditor").then((module) => ({ default: module.MarkdownEditor })));

type View = "topics" | "search" | "tags" | "history" | "trash" | "publications" | "system";
type Notice = { kind: "error" | "success"; text: string } | null;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected Topical error.";
}

function useLoad<T>(loader: (() => Promise<T>) | null, dependencies: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: Boolean(loader) });
  useEffect(() => {
    let active = true;
    if (!loader) { setState({ loading: false }); return; }
    setState((current) => ({ ...current, loading: true, error: undefined }));
    loader().then((data) => active && setState({ data, loading: false })).catch((error) => active && setState({ error: errorMessage(error), loading: false }));
    return () => { active = false; };
  }, dependencies);
  return state;
}

export function App() {
  const [api, setApi] = useState<ApiClient>();
  const [bootstrap, setBootstrap] = useState<any>();
  const [connectionError, setConnectionError] = useState<string>();
  const [view, setView] = useState<View>("topics");
  const [selectedTopic, setSelectedTopic] = useState<string>();
  const [topicsRevision, setTopicsRevision] = useState(0);
  const [showCreate, setShowCreate] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  useEffect(() => {
    connectApi().then(({ api: connected, bootstrap: info }) => { setApi(connected); setBootstrap(info); }).catch((error) => setConnectionError(errorMessage(error)));
  }, []);

  const topics = useLoad<any>(api ? () => api.get("/topics?sort=recent&limit=100") : null, [api, topicsRevision]);

  if (connectionError) return <EmptyState title="Topical UI could not connect" detail={connectionError} />;
  if (!api) return <EmptyState title="Opening Topical" detail="Connecting to the local service…" />;

  const confirmNavigation = () => !hasUnsavedChanges || window.confirm("Discard the unsaved draft?");
  const navigate = (next: View) => {
    if (!confirmNavigation()) return;
    setView(next);
    if (next !== "topics") setSelectedTopic(undefined);
  };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">T</span><div><strong>Topical</strong><small>Local knowledge</small></div></div>
        <nav aria-label="Primary">
          <NavButton active={view === "topics"} onClick={() => navigate("topics")} icon="◫">Topics</NavButton>
          <NavButton active={view === "search"} onClick={() => navigate("search")} icon="⌕">Search</NavButton>
          <div className="nav-label">Manage</div>
          <NavButton active={view === "tags"} onClick={() => navigate("tags")} icon="#">Tags</NavButton>
          <NavButton active={view === "history"} onClick={() => navigate("history")} icon="↶">History</NavButton>
          <NavButton active={view === "trash"} onClick={() => navigate("trash")} icon="♲">Trash</NavButton>
          <NavButton active={view === "publications"} onClick={() => navigate("publications")} icon="↗">Publications</NavButton>
          <NavButton active={view === "system"} onClick={() => navigate("system")} icon="●">System</NavButton>
        </nav>
        <div className="sidebar-footer"><span className="status-dot" />Local only<small>{bootstrap?.version}</small></div>
      </aside>

      {view === "topics" && !selectedTopic && (
        <main className="surface">
          <PageHeader eyebrow="Workspace" title="Topics" actions={<button className="primary" onClick={() => setShowCreate(true)}>New topic</button>} />
          {topics.loading && <Loading />}
          {topics.error && <InlineError text={topics.error} />}
          <div className="topic-grid">
            {(topics.data?.topics || []).map((topic: any) => (
              <button className="topic-card" key={topic.id} onClick={() => setSelectedTopic(topic.id)}>
                <div className="topic-card-heading"><strong>{topic.title}</strong><span>→</span></div>
                <p>{topic.summary || "No summary yet."}</p>
                <TagList tags={topic.tags} />
                <small>{topic.documentCount || 1} file{topic.documentCount === 1 ? "" : "s"} · {new Date(topic.updatedAt).toLocaleDateString()}</small>
              </button>
            ))}
          </div>
          {!topics.loading && !topics.data?.topics?.length && <EmptyState title="No topics yet" detail="Create the first Markdown-backed topic." />}
        </main>
      )}
      {view === "topics" && selectedTopic && <TopicWorkspace api={api} topic={selectedTopic} onBack={() => { if (confirmNavigation()) setSelectedTopic(undefined); }} onChanged={() => setTopicsRevision((value) => value + 1)} onDirtyChange={setHasUnsavedChanges} />}
      {view === "search" && <SearchView api={api} onOpen={(topic: string) => { setView("topics"); setSelectedTopic(topic); }} />}
      {view === "tags" && <TagsView api={api} />}
      {view === "history" && <HistoryView api={api} />}
      {view === "trash" && <TrashView api={api} />}
      {view === "publications" && <PublicationsView api={api} topics={topics.data?.topics || []} />}
      {view === "system" && <SystemView api={api} />}
      {showCreate && <CreateTopic api={api} onClose={() => setShowCreate(false)} onCreated={(topic: string) => { setShowCreate(false); setTopicsRevision((value) => value + 1); setSelectedTopic(topic); }} />}
    </div>
  );
}

function NavButton({ active, icon, children, onClick }: { active: boolean; icon: string; children: ReactNode; onClick(): void }) {
  return <button className={`nav-button ${active ? "active" : ""}`} onClick={onClick}><span>{icon}</span>{children}</button>;
}

function PageHeader({ eyebrow, title, subtitle, actions }: { eyebrow: ReactNode; title: string; subtitle?: string; actions?: ReactNode }) {
  return <header className="page-header"><div><small>{eyebrow}</small><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div><div className="header-actions">{actions}</div></header>;
}

function TopicWorkspace({ api, topic, onBack, onChanged, onDirtyChange }: { api: ApiClient; topic: string; onBack(): void; onChanged(): void; onDirtyChange(dirty: boolean): void }) {
  const [revision, setRevision] = useState(0);
  const overview = useLoad<any>(() => api.get(`/topics/${encodeURIComponent(topic)}/overview`), [api, topic, revision]);
  const [selectedPath, setSelectedPath] = useState("context.md");
  const [file, setFile] = useState<any>();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [conflict, setConflict] = useState<any>();
  const [showMetadata, setShowMetadata] = useState(false);
  const [showNewFile, setShowNewFile] = useState(false);

  const dirty = Boolean(file && draft !== file.content);
  useEffect(() => {
    let active = true;
    api.get(`/topic-file${queryString({ topic, path: selectedPath })}`).then((value) => {
      if (!active) return;
      setFile(value); setDraft(value.content); setEditing(false); setDescription("");
    }).catch((error) => active && setNotice({ kind: "error", text: errorMessage(error) }));
    return () => { active = false; };
  }, [api, topic, selectedPath, revision]);
  useEffect(() => { setNotice(null); }, [topic, selectedPath]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  const save = async () => {
    if (!description.trim()) { setNotice({ kind: "error", text: "Describe the change before saving." }); return; }
    try {
      const result = await api.send("PATCH", "/topic-file", { topic, filePath: selectedPath, mode: "replace", content: draft, expectedHash: file.hash, description });
      setFile({ ...file, content: draft, hash: result.hash });
      setDescription(""); setEditing(false); setNotice({ kind: "success", text: "Saved with conflict protection and an audit entry." });
      setRevision((value) => value + 1); onChanged();
    } catch (error) {
      if (error instanceof ApiError && error.code === "CONFLICT") {
        const current = await api.get(`/topic-file${queryString({ topic, path: selectedPath })}`);
        setConflict({ current, draft, details: error.details });
      } else setNotice({ kind: "error", text: errorMessage(error) });
    }
  };

  const deleteFile = async () => {
    const change = window.prompt(`Describe why ${selectedPath} should be moved to trash:`);
    if (!change) return;
    if (!window.confirm(`Move ${selectedPath} to recoverable trash?`)) return;
    try {
      await api.send("DELETE", "/topic-file", { topic, filePath: selectedPath, expectedHash: file.hash, description: change });
      setSelectedPath("context.md"); setRevision((value) => value + 1); onChanged();
    } catch (error) { setNotice({ kind: "error", text: errorMessage(error) }); }
  };

  const deleteTopic = async () => {
    const change = window.prompt(`Describe why ${metadata.title} should be moved to trash:`);
    if (!change || !window.confirm(`Move the entire ${metadata.title} topic to recoverable trash?`)) return;
    try {
      await api.send("DELETE", "/topic", { topic, expectedHash: contextHash, description: change });
      onChanged(); onBack();
    } catch (error) { setNotice({ kind: "error", text: errorMessage(error) }); }
  };

  if (overview.error) return <main className="surface"><InlineError text={overview.error} /></main>;
  if (notice?.kind === "error" && !file) return <main className="surface"><InlineError text={notice.text} /></main>;
  if (overview.loading || !overview.data || !file) return <main className="surface"><Loading /></main>;
  const metadata = overview.data.metadata;
  const contextHash = overview.data.files.find((item: any) => item.path === "context.md")?.hash;
  return (
    <main className="workspace">
      <section className="document-pane">
        <PageHeader eyebrow={<button className="text-button" onClick={onBack}>← Topics</button>} title={metadata.title} subtitle={metadata.summary} actions={<><button onClick={() => setShowMetadata(true)}>Edit details</button><button className={editing ? "" : "primary"} onClick={() => setEditing((value) => !value)}>{editing ? "Read" : "Edit"}</button></>} />
        {notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}
        {editing ? (
          <div className="edit-layout">
            <div><div className="section-label">Markdown source</div><Suspense fallback={<Loading />}><MarkdownEditor value={draft} onChange={setDraft} /></Suspense></div>
            <div><div className="section-label">Safe preview</div><MarkdownView>{draft}</MarkdownView></div>
          </div>
        ) : <MarkdownView>{file.content}</MarkdownView>}
        {editing && <div className="save-bar"><input aria-label="Change description" placeholder="Describe this change for the audit history" value={description} onChange={(event) => setDescription(event.target.value)} /><span>{dirty ? "Unsaved changes" : "No changes"}</span><button onClick={() => { setDraft(file.content); setEditing(false); }}>Cancel</button><button className="primary" disabled={!dirty} onClick={save}>Save safely</button></div>}
      </section>
      <aside className="context-pane">
        <div className="context-heading"><span>Files</span><button className="icon-button" aria-label="Create supporting file" onClick={() => setShowNewFile(true)}>＋</button></div>
        <div className="file-list">
          {overview.data.files.map((item: any) => <button key={item.path} className={selectedPath === item.path ? "active" : ""} onClick={() => { if (!dirty || window.confirm("Discard the unsaved draft?")) setSelectedPath(item.path); }}><span>◇</span>{item.path}</button>)}
        </div>
        <div className="context-section"><span className="section-label">Tags</span><TagList tags={metadata.tags} /></div>
        <div className="context-section"><span className="section-label">File hash</span><code className="hash">{file.hash}</code></div>
        {selectedPath !== "context.md" && <button className="danger subtle" onClick={deleteFile}>Move file to trash</button>}
        <button className="danger subtle" onClick={deleteTopic}>Move topic to trash</button>
      </aside>
      {conflict && <ConflictDialog conflict={conflict} onClose={() => setConflict(null)} onReload={() => { setFile(conflict.current); setDraft(conflict.current.content); setConflict(null); }} onReview={() => { setFile(conflict.current); setConflict(null); setNotice({ kind: "success", text: "Current version reviewed. Reconcile the draft, then save explicitly." }); }} />}
      {showMetadata && <MetadataDialog api={api} topic={topic} metadata={metadata} expectedHash={contextHash} onClose={() => setShowMetadata(false)} onSaved={() => { setShowMetadata(false); setRevision((value) => value + 1); onChanged(); }} />}
      {showNewFile && <NewFileDialog api={api} topic={topic} onClose={() => setShowNewFile(false)} onCreated={(path: string) => { setShowNewFile(false); setRevision((value) => value + 1); setSelectedPath(path); onChanged(); }} />}
    </main>
  );
}

function ConflictDialog({ conflict, onClose, onReload, onReview }: { conflict: any; onClose(): void; onReload(): void; onReview(): void }) {
  return <Dialog title="This file changed elsewhere" onClose={onClose}><p>Your draft was not written. Review both versions before choosing a new base hash.</p><div className="conflict-grid"><div><strong>Current Markdown</strong><pre>{conflict.current.content}</pre></div><div><strong>Your draft</strong><pre>{conflict.draft}</pre></div></div><div className="dialog-actions"><button onClick={onReload}>Discard draft and reload</button><button className="primary" onClick={onReview}>Keep draft after review</button></div></Dialog>;
}

function MetadataDialog({ api, topic, metadata, expectedHash, onClose, onSaved }: any) {
  const [title, setTitle] = useState(metadata.title);
  const [summary, setSummary] = useState(metadata.summary || "");
  const [tagText, setTagText] = useState((metadata.tags || []).join(", "));
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.send("PATCH", "/topic-metadata", { topic, title, summary, tags: tagText.split(",").map((item: string) => item.trim()).filter(Boolean), expectedHash, description });
      onSaved();
    } catch (reason) { setError(errorMessage(reason)); }
  };
  return <Dialog title="Edit topic details" onClose={onClose}><form className="form-stack" onSubmit={submit}><label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} required /></label><label>Summary<textarea value={summary} onChange={(event) => setSummary(event.target.value)} /></label><label>Tags <small>Comma-separated; zero is normal.</small><input value={tagText} onChange={(event) => setTagText(event.target.value)} /></label><label>Change description<input value={description} onChange={(event) => setDescription(event.target.value)} required minLength={3} /></label>{error && <InlineError text={error} />}<div className="dialog-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary">Save details</button></div></form></Dialog>;
}

function NewFileDialog({ api, topic, onClose, onCreated }: any) {
  const [path, setPath] = useState(""); const [content, setContent] = useState("# New note\n\n"); const [description, setDescription] = useState(""); const [error, setError] = useState<string>();
  const submit = async (event: FormEvent) => { event.preventDefault(); try { await api.send("POST", "/topic-files", { topic, filePath: path, content, description }); onCreated(path); } catch (reason) { setError(errorMessage(reason)); } };
  return <Dialog title="Create supporting file" onClose={onClose}><form className="form-stack" onSubmit={submit}><label>Topic-relative Markdown path<input placeholder="research/notes.md" value={path} onChange={(event) => setPath(event.target.value)} required /></label><label>Initial Markdown<textarea rows={8} value={content} onChange={(event) => setContent(event.target.value)} /></label><label>Change description<input value={description} onChange={(event) => setDescription(event.target.value)} required minLength={3} /></label>{error && <InlineError text={error} />}<div className="dialog-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary">Create file</button></div></form></Dialog>;
}

function CreateTopic({ api, onClose, onCreated }: any) {
  const [title, setTitle] = useState(""); const [summary, setSummary] = useState(""); const [tagText, setTagText] = useState(""); const [content, setContent] = useState(""); const [description, setDescription] = useState(""); const [error, setError] = useState<string>();
  const submit = async (event: FormEvent) => { event.preventDefault(); try { const result = await api.send("POST", "/topics", { title, summary, tags: tagText.split(",").map((item) => item.trim()).filter(Boolean), initialContent: content, description }); onCreated(result.topic); } catch (reason) { setError(errorMessage(reason)); } };
  return <Dialog title="Create topic" onClose={onClose}><form className="form-stack" onSubmit={submit}><label>Title<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} required /></label><label>Summary<textarea value={summary} onChange={(event) => setSummary(event.target.value)} /></label><label>Tags<input placeholder="optional, sparse, recurring" value={tagText} onChange={(event) => setTagText(event.target.value)} /></label><label>Initial Markdown<textarea rows={8} value={content} onChange={(event) => setContent(event.target.value)} /></label><label>Change description<input value={description} onChange={(event) => setDescription(event.target.value)} required minLength={3} /></label>{error && <InlineError text={error} />}<div className="dialog-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary">Create topic</button></div></form></Dialog>;
}

function SearchView({ api, onOpen }: { api: ApiClient; onOpen(topic: string): void }) {
  const [query, setQuery] = useState(""); const [submitted, setSubmitted] = useState(""); const [result, setResult] = useState<any>(); const [error, setError] = useState<string>();
  const search = async (event: FormEvent) => { event.preventDefault(); setSubmitted(query); setError(undefined); try { setResult(await api.get(`/search${queryString({ q: query, limit: 20 })}`)); } catch (reason) { setError(errorMessage(reason)); } };
  return <main className="surface"><PageHeader eyebrow="Retrieval" title="Search" subtitle="Topic-grouped, strict first, with every widening step visible." /><form className="search-bar" onSubmit={search}><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search titles, tags, headings, and Markdown…" /><button className="primary">Search</button></form>{error && <InlineError text={error} />}{result && <><div className="result-summary"><ModeBadge mode={result.matchMode} /><span>{result.topics.length} topic{result.topics.length === 1 ? "" : "s"}</span>{result.analysis?.ignoredTerms?.length ? <span>{result.analysis.ignoredTerms.length} ignored term(s)</span> : null}</div><div className="result-list">{result.topics.map((item: any) => <button className="result-card" key={item.topic} onClick={() => onOpen(item.topic)}><div><strong>{item.title}</strong><TagList tags={item.tags} /></div><p>{item.files?.[0]?.snippet || item.summary}</p><small>{(item.matchedFields || []).join(" · ")}{item.files?.[0]?.path ? ` · ${item.files[0].path}` : ""}</small></button>)}</div>{!result.topics.length && <EmptyState title={`No results for “${submitted}”`} detail="Topical exhausted exact and approved bounded fallback modes." />}</>}</main>;
}

function TagsView({ api }: { api: ApiClient }) {
  const data = useLoad<any>(() => api.get("/tags?limit=100"), [api]);
  return <main className="surface"><PageHeader eyebrow="Taxonomy" title="Tags" subtitle="Guidance and warnings only. Authored metadata is never rewritten automatically." />{data.loading && <Loading />}{data.error && <InlineError text={data.error} />}<div className="table-list">{(data.data?.tags || []).map((item: any) => <div className="table-row" key={item.canonical || item.tag}><div><strong>#{item.display || item.tag}</strong><small>{item.canonical && item.canonical !== item.display ? `Canonical: ${item.canonical}` : "Recurring facet"}</small></div><span>{item.count} topic{item.count === 1 ? "" : "s"}</span></div>)}</div>{data.data?.warnings?.map((warning: any, index: number) => <div className="notice" key={index}>{warning.message || JSON.stringify(warning)}</div>)}</main>;
}

function HistoryView({ api }: { api: ApiClient }) {
  const data = useLoad<any>(() => api.get("/history?limit=100"), [api]);
  return <main className="surface"><PageHeader eyebrow="Audit" title="History" subtitle="Newest-first descriptions for every recorded mutation." />{data.loading && <Loading />}{data.error && <InlineError text={data.error} />}<div className="timeline">{(data.data?.events || []).map((event: any, index: number) => <div className="timeline-item" key={`${event.at}-${index}`}><span /><div><strong>{event.description}</strong><p>{event.topic}{event.path ? ` / ${event.path}` : ""} · {event.action}</p><small>{new Date(event.at).toLocaleString()}</small></div></div>)}</div></main>;
}

function TrashView({ api }: { api: ApiClient }) {
  const [revision, setRevision] = useState(0); const [notice, setNotice] = useState<Notice>(null);
  const data = useLoad<any>(() => api.get("/trash?limit=100"), [api, revision]);
  const restore = async (entry: any) => { const description = window.prompt(`Describe why ${entry.topic}${entry.path ? `/${entry.path}` : ""} is being restored:`); if (!description) return; try { await api.send("POST", `/trash/${entry.id}/restore`, { expectedHash: entry.hash, description }); setNotice({ kind: "success", text: "Restored from trash." }); setRevision((value) => value + 1); } catch (error) { setNotice({ kind: "error", text: errorMessage(error) }); } };
  return <main className="surface"><PageHeader eyebrow="Recovery" title="Trash" subtitle="Soft-deleted files and topics remain recoverable; Topical never purges them automatically." />{notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}{data.loading && <Loading />}{data.error && <InlineError text={data.error} />}<div className="table-list">{(data.data?.entries || []).map((entry: any) => <div className="table-row" key={entry.id}><div><strong>{entry.topic}{entry.path ? ` / ${entry.path}` : ""}</strong><small>{entry.type} · {new Date(entry.trashedAt).toLocaleString()} · {entry.description}</small></div><button onClick={() => restore(entry)}>Restore</button></div>)}</div>{!data.loading && !data.data?.entries?.length && <EmptyState title="Trash is empty" detail="Deleted content will appear here with a recoverable hash." />}</main>;
}

function SystemView({ api }: { api: ApiClient }) {
  const [revision, setRevision] = useState(0); const [notice, setNotice] = useState<Notice>(null); const data = useLoad<any>(() => api.get("/health"), [api, revision]);
  const reindex = async () => { if (!window.confirm("Rebuild disposable derived indexes from authoritative Markdown?")) return; try { await api.send("POST", "/reindex", { description: "Rebuilt derived indexes from the management UI." }); setNotice({ kind: "success", text: "Derived indexes rebuilt from Markdown." }); setRevision((value) => value + 1); } catch (error) { setNotice({ kind: "error", text: errorMessage(error) }); } };
  return <main className="surface"><PageHeader eyebrow="Diagnostics" title="System" subtitle="Markdown authority and disposable derived-state health." actions={<button onClick={reindex}>Reindex</button>} />{notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}{data.loading && <Loading />}{data.error && <InlineError text={data.error} />}{data.data && <div className="health-grid">{Object.entries(data.data).map(([key, value]) => <div className="health-card" key={key}><small>{key.replace(/[A-Z]/g, (match) => ` ${match}`).toUpperCase()}</small><strong>{typeof value === "object" ? ((value as any)?.status || "Ready") : String(value)}</strong><pre>{typeof value === "object" ? JSON.stringify(value, null, 2) : ""}</pre></div>)}</div>}</main>;
}

function PublicationsView({ api, topics }: { api: ApiClient; topics: any[] }) {
  const [revision, setRevision] = useState(0); const [selected, setSelected] = useState<string>(); const [detail, setDetail] = useState<any>(); const [notice, setNotice] = useState<Notice>(null); const [showCreate, setShowCreate] = useState(false); const [showUpdate, setShowUpdate] = useState(false);
  const data = useLoad<any>(() => api.get("/publications?limit=100"), [api, revision]);
  useEffect(() => { if (selected) api.get(`/publications/${selected}`).then(setDetail).catch((error) => setNotice({ kind: "error", text: errorMessage(error) })); }, [api, selected, revision]);
  const forget = async () => { if (!detail || !window.confirm("Archive this publication relationship? The destination document will remain unchanged.")) return; const description = window.prompt("Describe why this relationship is being archived:"); if (!description) return; try { await api.send("DELETE", `/publications/${detail.record.id}`, { description }); setSelected(undefined); setDetail(undefined); setRevision((value) => value + 1); } catch (error) { setNotice({ kind: "error", text: errorMessage(error) }); } };
  return <main className="surface"><PageHeader eyebrow="Checkpoints" title="Publications" subtitle="Explicit independent Markdown checkpoints—never automatic synchronization." actions={<button className="primary" onClick={() => setShowCreate(true)}>New publication</button>} />{notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}{data.loading && <Loading />}{data.error && <InlineError text={data.error} />}<div className="split-list"><div className="table-list">{(data.data?.publications || []).map((item: any) => <button className={`table-row ${selected === item.id ? "selected" : ""}`} key={item.id} onClick={() => setSelected(item.id)}><div><strong>{item.label || item.destination.path}</strong><small>{item.topic} · {item.destination.alias}/{item.destination.path}</small></div><ModeBadge mode={item.state} /></button>)}</div>{detail && <section className="publication-detail"><div className="section-label">Relationship state</div><h2>{detail.record.label || detail.record.destination.path}</h2><ModeBadge mode={detail.status.state} /><p>{detail.status.guidance?.message}</p><div className="section-label">Current destination</div>{detail.currentContent === null ? <p>Destination unavailable or missing.</p> : <MarkdownView>{detail.currentContent}</MarkdownView>}<div className="dialog-actions"><button className="danger subtle" onClick={forget}>Forget relationship</button><button disabled={!detail.status.currentTargetHash} onClick={() => setShowUpdate(true)}>Update checkpoint</button></div></section>}</div>{showCreate && <CreatePublication api={api} topics={topics} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); setRevision((value) => value + 1); }} />}{showUpdate && detail && <UpdatePublication api={api} detail={detail} onClose={() => setShowUpdate(false)} onUpdated={() => { setShowUpdate(false); setRevision((value) => value + 1); }} />}</main>;
}

function UpdatePublication({ api, detail, onClose, onUpdated }: any) {
  const [content, setContent] = useState(detail.currentContent || detail.snapshot || ""); const [description, setDescription] = useState(""); const [error, setError] = useState<string>();
  const submit = async (event: FormEvent) => { event.preventDefault(); try { await api.send("PUT", `/publications/${detail.record.id}`, { content, expectedTargetHash: detail.status.currentTargetHash, sourceFiles: detail.record.sourceFiles.map((source: any) => source.path), description }); onUpdated(); } catch (reason) { setError(errorMessage(reason)); } };
  return <Dialog title="Update publication checkpoint" onClose={onClose}><p>This writes a new explicit checkpoint after comparing the current destination hash. It is not synchronization.</p><form className="form-stack" onSubmit={submit}><label>Complete destination Markdown<textarea rows={14} value={content} onChange={(event) => setContent(event.target.value)} required /></label><label>Change description<input value={description} onChange={(event) => setDescription(event.target.value)} required minLength={3} /></label>{error && <InlineError text={error} />}<div className="dialog-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary">Write checkpoint</button></div></form></Dialog>;
}

function CreatePublication({ api, topics, onClose, onCreated }: any) {
  const [topic, setTopic] = useState(topics[0]?.id || ""); const [alias, setAlias] = useState(""); const [path, setPath] = useState(""); const [label, setLabel] = useState(""); const [content, setContent] = useState(""); const [description, setDescription] = useState(""); const [error, setError] = useState<string>();
  const submit = async (event: FormEvent) => { event.preventDefault(); try { await api.send("POST", "/publications", { topic, sourceFiles: ["context.md"], destinationAlias: alias, destinationPath: path, label: label || undefined, content, description }); onCreated(); } catch (reason) { setError(errorMessage(reason)); } };
  return <Dialog title="Create publication checkpoint" onClose={onClose}><form className="form-stack" onSubmit={submit}><label>Topic<select value={topic} onChange={(event) => setTopic(event.target.value)}>{topics.map((item: any) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><div className="field-row"><label>Destination alias<input value={alias} onChange={(event) => setAlias(event.target.value)} required /></label><label>Markdown path<input value={path} onChange={(event) => setPath(event.target.value)} required /></label></div><label>Label<input value={label} onChange={(event) => setLabel(event.target.value)} /></label><label>Complete standalone Markdown<textarea rows={12} value={content} onChange={(event) => setContent(event.target.value)} required /></label><label>Change description<input value={description} onChange={(event) => setDescription(event.target.value)} required minLength={3} /></label>{error && <InlineError text={error} />}<div className="dialog-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary">Publish checkpoint</button></div></form></Dialog>;
}

function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose(): void }) {
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><section className="dialog" role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button className="icon-button" aria-label="Close" onClick={onClose}>×</button></header>{children}</section></div>;
}

function ModeBadge({ mode }: { mode: string }) { return <span className={`mode mode-${String(mode).replaceAll("_", "-")}`}>{String(mode).replaceAll("_", " ")}</span>; }
function TagList({ tags = [] }: { tags?: string[] }) { return <div className="tag-list">{tags.map((tag) => <span key={tag}>#{tag}</span>)}</div>; }
function Loading() { return <div className="loading"><span />Loading…</div>; }
function InlineError({ text }: { text: string }) { return <div className="notice error">{text}</div>; }
function EmptyState({ title, detail }: { title: string; detail: string }) { return <main className="empty-state"><div className="empty-mark">◇</div><h2>{title}</h2><p>{detail}</p></main>; }
