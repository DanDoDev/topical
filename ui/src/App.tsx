import { Component, FormEvent, ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { ApiClient, ApiError, connectApi, queryString } from "./api";
import { formatEnglishDate } from "./dates";
import { MarkdownEditor } from "./MarkdownEditor";
import { MarkdownView } from "./MarkdownView";

type View = "topics" | "search" | "tags" | "history" | "trash" | "publications" | "system";
type Notice = { kind: "error" | "success"; text: string } | null;
type DocumentTab = { key: string; topic: string; path: string; title: string };
type FileSort = "recent" | "name";

const MAX_DOCUMENT_TABS = 12;
const TAB_SESSION_KEY = "topical.document-tabs.v1";

function documentTabKey(topic: string, path: string) { return `${topic}\u0000${path}`; }
function validStoredTab(tab: unknown): tab is DocumentTab {
  if (!tab || typeof tab !== "object") return false;
  const candidate = tab as Record<string, unknown>;
  return typeof candidate.topic === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate.topic)
    && typeof candidate.path === "string" && candidate.path.endsWith(".md") && !candidate.path.includes("\\") && !candidate.path.split("/").includes("..")
    && typeof candidate.title === "string" && candidate.title.length > 0
    && candidate.key === documentTabKey(candidate.topic, candidate.path);
}
function loadTabSession(): { tabs: DocumentTab[]; active?: string; collapsedTopics: string[] } {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(TAB_SESSION_KEY) || "null");
    const tabs = Array.isArray(parsed?.tabs) ? parsed.tabs.filter(validStoredTab).slice(0, MAX_DOCUMENT_TABS) : [];
    const active = tabs.some((tab: DocumentTab) => tab.key === parsed?.active) ? parsed.active : tabs[0]?.key;
    const topics = new Set(tabs.map((tab: DocumentTab) => tab.topic));
    const collapsedTopics = Array.isArray(parsed?.collapsedTopics) ? parsed.collapsedTopics.filter((topic: unknown) => typeof topic === "string" && topics.has(topic)) : [];
    return { tabs, active, collapsedTopics };
  } catch { return { tabs: [], collapsedTopics: [] }; }
}

export function reorderDocumentTabs(tabs: DocumentTab[], sourceKey: string, targetKey: string) {
  const source = tabs.findIndex((tab) => tab.key === sourceKey);
  const target = tabs.findIndex((tab) => tab.key === targetKey);
  if (source < 0 || target < 0 || source === target || tabs[source].topic !== tabs[target].topic) return tabs;
  const next = [...tabs];
  const [moved] = next.splice(source, 1);
  next.splice(target, 0, moved);
  return next;
}

export function reorderTopicGroups(tabs: DocumentTab[], sourceTopic: string, targetTopic: string) {
  if (sourceTopic === targetTopic) return tabs;
  const order = [...new Set(tabs.map((tab) => tab.topic))];
  const source = order.indexOf(sourceTopic);
  const target = order.indexOf(targetTopic);
  if (source < 0 || target < 0) return tabs;
  order.splice(source, 1);
  order.splice(target, 0, sourceTopic);
  return order.flatMap((topic) => tabs.filter((tab) => tab.topic === topic));
}

export class ViewErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error?: Error }> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) { return { error }; }

  componentDidUpdate(previous: { resetKey: string }) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: undefined });
  }

  render() {
    if (this.state.error) {
      return <main className="surface"><EmptyState title="This view could not be shown" detail={`${this.state.error.message} Choose another section from the sidebar to continue.`} /></main>;
    }
    return this.props.children;
  }
}

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

function useStoreRevision(api: ApiClient | undefined, initialRevision: string | undefined) {
  const [revision, setRevision] = useState(0);
  const lastSeen = useRef(initialRevision);
  useEffect(() => { if (initialRevision) lastSeen.current = initialRevision; }, [initialRevision]);
  useEffect(() => {
    if (!api) return;
    let active = true;
    let checking = false;
    const check = async () => {
      if (checking || !active) return;
      checking = true;
      try {
        const current = await api.get<{ revision: string }>("/revision");
        if (lastSeen.current && current.revision !== lastSeen.current) setRevision((value) => value + 1);
        lastSeen.current = current.revision;
      } catch {
        // The next interval or focus event retries without disrupting the active view.
      } finally { checking = false; }
    };
    const interval = window.setInterval(check, 1200);
    const focus = () => void check();
    const visible = () => { if (document.visibilityState === "visible") void check(); };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visible);
    void check();
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [api]);
  return revision;
}

export function App() {
  const [initialTabs] = useState(loadTabSession);
  const [api, setApi] = useState<ApiClient>();
  const [bootstrap, setBootstrap] = useState<any>();
  const [connectionError, setConnectionError] = useState<string>();
  const [view, setView] = useState<View>("topics");
  const [tabs, setTabs] = useState<DocumentTab[]>(initialTabs.tabs);
  const [activeTabKey, setActiveTabKey] = useState<string | undefined>(initialTabs.active);
  const [collapsedTopics, setCollapsedTopics] = useState<string[]>(initialTabs.collapsedTopics);
  const [showTopicList, setShowTopicList] = useState(initialTabs.tabs.length === 0);
  const [dirtyTabs, setDirtyTabs] = useState<Record<string, boolean>>({});
  const [topicsRevision, setTopicsRevision] = useState(0);
  const [showCreate, setShowCreate] = useState(false);
  const [sidebarQuery, setSidebarQuery] = useState("");
  const [searchRequest, setSearchRequest] = useState({ query: "", key: 0 });
  const [topicTags, setTopicTags] = useState<string[]>([]);

  useEffect(() => {
    connectApi().then(({ api: connected, bootstrap: info }) => { setApi(connected); setBootstrap(info); }).catch((error) => setConnectionError(errorMessage(error)));
  }, []);

  const liveRevision = useStoreRevision(api, bootstrap?.revision);
  const topics = useLoad<any>(api ? () => api.get(`/topics${queryString({ sort: "recent", limit: 100, tags: topicTags })}`) : null, [api, topicsRevision, liveRevision, topicTags]);

  useEffect(() => {
    window.sessionStorage.setItem(TAB_SESSION_KEY, JSON.stringify({ tabs, active: activeTabKey, collapsedTopics }));
  }, [tabs, activeTabKey, collapsedTopics]);

  const reportDirty = useCallback((key: string, dirty: boolean) => {
    setDirtyTabs((current) => current[key] === dirty ? current : { ...current, [key]: dirty });
  }, []);

  if (connectionError) return <EmptyState title="Topical UI could not connect" detail={connectionError} />;
  if (!api) return <EmptyState title="Opening Topical" detail="Connecting to the local service…" />;

  const navigate = (next: View) => {
    setView(next);
    if (next === "topics") setShowTopicList(true);
  };
  const searchFromSidebar = (event: FormEvent) => {
    event.preventDefault();
    const query = sidebarQuery.trim();
    if (!query) return;
    setView("search");
    setSearchRequest((current) => ({ query, key: current.key + 1 }));
  };
  const openTag = (tag: string) => {
    setTopicTags((current) => current.some((item) => item.localeCompare(tag, undefined, { sensitivity: "accent" }) === 0) ? current : [...current, tag]);
    setView("topics");
    setShowTopicList(true);
  };
  const openDocument = (topic: string, path = "context.md", title?: string) => {
    const key = documentTabKey(topic, path);
    const existing = tabs.find((tab) => tab.key === key);
    if (!existing && tabs.length >= MAX_DOCUMENT_TABS) {
      window.alert(`Topical keeps at most ${MAX_DOCUMENT_TABS} documents open. Close a tab before opening another.`);
      return;
    }
    if (!existing) {
      const topicTitle = title || topics.data?.topics?.find((item: any) => item.id === topic)?.title || topic;
      setTabs((current) => [...current, { key, topic, path, title: topicTitle }]);
    }
    setActiveTabKey(key);
    setView("topics");
    setShowTopicList(false);
  };
  const closeTab = (key: string, force = false) => {
    if (!force && dirtyTabs[key] && !window.confirm("Discard the unsaved draft in this tab?")) return;
    const index = tabs.findIndex((tab) => tab.key === key);
    const next = tabs.filter((tab) => tab.key !== key);
    setTabs(next);
    if (activeTabKey === key) {
      const replacement = next[Math.min(index, next.length - 1)];
      setActiveTabKey(replacement?.key);
      if (!replacement) setShowTopicList(true);
    }
    setDirtyTabs((current) => { const next = { ...current }; delete next[key]; return next; });
  };
  const closeTopicTabs = (topic: string) => {
    const keys = new Set(tabs.filter((tab) => tab.topic === topic).map((tab) => tab.key));
    setTabs((current) => current.filter((tab) => !keys.has(tab.key)));
    setDirtyTabs((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !keys.has(key))));
    if (activeTabKey && keys.has(activeTabKey)) setActiveTabKey(tabs.find((tab) => !keys.has(tab.key))?.key);
    setShowTopicList(true);
  };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">T</span><div><strong>Topical</strong><small>Local knowledge</small></div></div>
        <form className="sidebar-search" onSubmit={searchFromSidebar} role="search">
          <span aria-hidden="true">⌕</span>
          <input aria-label="Search Topical" placeholder="Search…" value={sidebarQuery} onChange={(event) => setSidebarQuery(event.target.value)} />
        </form>
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

      <div className="app-content">
      <DocumentTabs tabs={tabs} activeKey={activeTabKey} dirtyTabs={dirtyTabs} collapsedTopics={collapsedTopics} onToggleTopic={(topic) => setCollapsedTopics((current) => current.includes(topic) ? current.filter((item) => item !== topic) : [...current, topic])} onReorderTab={(source, target) => setTabs((current) => reorderDocumentTabs(current, source, target))} onReorderGroup={(source, target) => setTabs((current) => reorderTopicGroups(current, source, target))} onFocus={(key) => { setActiveTabKey(key); setView("topics"); setShowTopicList(false); }} onClose={closeTab} />
      <ViewErrorBoundary resetKey={`${view}:${activeTabKey || ""}`}>
      {view === "topics" && showTopicList && (
        <main className="surface">
          <PageHeader eyebrow="Workspace" title="Topics" actions={<button className="primary" onClick={() => setShowCreate(true)}>New topic</button>} />
          {topicTags.length > 0 && <div className="filter-bar" aria-label="Active topic filters"><span>Matching all tags</span>{topicTags.map((tag) => <button key={tag} onClick={() => setTopicTags((current) => current.filter((item) => item !== tag))}>#{tag}<span aria-hidden="true"> ×</span></button>)}<button className="subtle" onClick={() => setTopicTags([])}>Clear filters</button></div>}
          {topics.loading && <Loading />}
          {topics.error && <InlineError text={topics.error} />}
          <div className="topic-grid">
            {(topics.data?.topics || []).map((topic: any) => <TopicCard key={topic.id} topic={topic} onOpen={() => openDocument(topic.id, "context.md", topic.title)} onTagClick={openTag} />)}
          </div>
          {!topics.loading && !topics.data?.topics?.length && <EmptyState title="No topics yet" detail="Create the first Markdown-backed topic." />}
        </main>
      )}
      {tabs.map((tab) => <div className="workspace-slot" hidden={view !== "topics" || showTopicList || activeTabKey !== tab.key} key={tab.key}><TopicWorkspace api={api} topic={tab.topic} path={tab.path} liveRevision={liveRevision} onBack={() => setShowTopicList(true)} onChanged={() => setTopicsRevision((value) => value + 1)} onDirtyChange={(dirty) => reportDirty(tab.key, dirty)} onOpenDocument={openDocument} onDeletedFile={() => { closeTab(tab.key, true); openDocument(tab.topic); }} onDeletedTopic={() => { closeTopicTabs(tab.topic); setTopicsRevision((value) => value + 1); }} onTagClick={openTag} /></div>)}
      {view === "search" && <SearchView api={api} liveRevision={liveRevision} request={searchRequest} onOpen={openDocument} onTagClick={openTag} />}
      {view === "tags" && <TagsView api={api} liveRevision={liveRevision} onTagClick={openTag} />}
      {view === "history" && <HistoryView api={api} liveRevision={liveRevision} onOpenFile={openDocument} />}
      {view === "trash" && <TrashView api={api} liveRevision={liveRevision} />}
      {view === "publications" && <PublicationsView api={api} topics={topics.data?.topics || []} liveRevision={liveRevision} />}
      {view === "system" && <SystemView api={api} liveRevision={liveRevision} />}
      </ViewErrorBoundary>
      </div>
      {showCreate && <CreateTopic api={api} onClose={() => setShowCreate(false)} onCreated={(topic: string) => { setShowCreate(false); setTopicsRevision((value) => value + 1); openDocument(topic); }} />}
    </div>
  );
}

function DocumentTabs({ tabs, activeKey, dirtyTabs, collapsedTopics, onToggleTopic, onReorderTab, onReorderGroup, onFocus, onClose }: { tabs: DocumentTab[]; activeKey?: string; dirtyTabs: Record<string, boolean>; collapsedTopics: string[]; onToggleTopic(topic: string): void; onReorderTab(source: string, target: string): void; onReorderGroup(source: string, target: string): void; onFocus(key: string): void; onClose(key: string): void }) {
  const [draggedTab, setDraggedTab] = useState<string>();
  const [overTab, setOverTab] = useState<string>();
  const [draggedGroup, setDraggedGroup] = useState<string>();
  const [overGroup, setOverGroup] = useState<string>();
  const nodes = useRef(new Map<string, HTMLElement>());
  const positions = useRef(new Map<string, DOMRect>());

  useLayoutEffect(() => {
    const next = new Map<string, DOMRect>();
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const [key, node] of nodes.current) {
      if (!node.isConnected) { nodes.current.delete(key); continue; }
      const rect = node.getBoundingClientRect();
      next.set(key, rect);
      const previous = positions.current.get(key);
      if (reduceMotion || !previous || (previous.left === rect.left && previous.top === rect.top)) continue;
      node.animate?.([
        { transform: `translate(${previous.left - rect.left}px, ${previous.top - rect.top}px)` },
        { transform: "translate(0, 0)" }
      ], { duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" });
    }
    positions.current = next;
  }, [tabs, collapsedTopics]);

  const finishDrag = () => { setDraggedTab(undefined); setOverTab(undefined); setDraggedGroup(undefined); setOverGroup(undefined); };
  if (!tabs.length) return null;
  const topics = [...new Set(tabs.map((tab) => tab.topic))];
  return <div className="document-tabs" aria-label="Open documents">{topics.map((topic) => {
    const groupTabs = tabs.filter((tab) => tab.topic === topic);
    const collapsed = collapsedTopics.includes(topic);
    return <section
      className={`tab-group ${collapsed ? "collapsed" : ""} ${draggedGroup === topic ? "dragging" : ""} ${overGroup === topic ? "drag-over" : ""}`}
      key={topic}
      ref={(node) => { if (node) nodes.current.set(`group:${topic}`, node); else nodes.current.delete(`group:${topic}`); }}
      draggable
      onDragStart={(event) => { setDraggedGroup(topic); setOverGroup(topic); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-topical-group", topic); event.dataTransfer.setDragImage(event.currentTarget, 24, 18); }}
      onDragEnter={(event) => { if (!draggedGroup || draggedGroup === topic || overGroup === topic) return; event.preventDefault(); setOverGroup(topic); onReorderGroup(draggedGroup, topic); }}
      onDragOver={(event) => { if (draggedGroup) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
      onDrop={(event) => { if (draggedGroup) event.preventDefault(); finishDrag(); }}
      onDragEnd={finishDrag}
    >
      <button className="tab-group-label" aria-expanded={!collapsed} onClick={() => onToggleTopic(topic)}><span aria-hidden="true" />{groupTabs[0].title}<small>{groupTabs.length}</small></button>
      {!collapsed && <div role="tablist" aria-label={`${groupTabs[0].title} documents`}>{groupTabs.map((tab) => <div
        className={`document-tab ${activeKey === tab.key ? "active" : ""} ${draggedTab === tab.key ? "dragging" : ""} ${overTab === tab.key ? "drag-over" : ""}`}
        key={tab.key}
        ref={(node) => { if (node) nodes.current.set(`tab:${tab.key}`, node); else nodes.current.delete(`tab:${tab.key}`); }}
        draggable
        onDragStart={(event) => { event.stopPropagation(); setDraggedTab(tab.key); setOverTab(tab.key); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-topical-tab", tab.key); event.dataTransfer.setDragImage(event.currentTarget, 28, 18); }}
        onDragEnter={(event) => { if (!draggedTab || draggedTab === tab.key || overTab === tab.key) return; event.preventDefault(); event.stopPropagation(); setOverTab(tab.key); onReorderTab(draggedTab, tab.key); }}
        onDragOver={(event) => { if (draggedTab) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; } }}
        onDrop={(event) => { if (draggedTab) { event.preventDefault(); event.stopPropagation(); } finishDrag(); }}
        onDragEnd={(event) => { event.stopPropagation(); finishDrag(); }}
      >
        <button role="tab" aria-label={`${tab.title} ${tab.path}${dirtyTabs[tab.key] ? " unsaved" : ""}`} aria-selected={activeKey === tab.key} onClick={() => onFocus(tab.key)} onKeyDown={(event) => { if (!event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return; const index = groupTabs.findIndex((item) => item.key === tab.key); const target = groupTabs[index + (event.key === "ArrowLeft" ? -1 : 1)]; if (target) { event.preventDefault(); onReorderTab(tab.key, target.key); } }}><strong>{tab.path}</strong><small>{dirtyTabs[tab.key] ? "Unsaved changes" : tab.topic}</small></button>
        <button className="tab-close" aria-label={`Close ${tab.title} ${tab.path}`} onClick={() => onClose(tab.key)}>×</button>
      </div>)}</div>}
    </section>;
  })}</div>;
}

function NavButton({ active, icon, children, onClick }: { active: boolean; icon: string; children: ReactNode; onClick(): void }) {
  return <button className={`nav-button ${active ? "active" : ""}`} onClick={onClick}><span>{icon}</span>{children}</button>;
}

function PageHeader({ eyebrow, title, subtitle, actions }: { eyebrow: ReactNode; title: string; subtitle?: string; actions?: ReactNode }) {
  return <header className="page-header"><div><small>{eyebrow}</small><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div><div className="header-actions">{actions}</div></header>;
}

export function TopicCard({ topic, onOpen, onTagClick }: { topic: any; onOpen(): void; onTagClick(tag: string): void }) {
  const fileCount = topic.fileCount ?? 0;
  return <article className="topic-card">
    <button className="topic-card-main" onClick={onOpen} aria-label={`Open ${topic.title}`}>
      <div className="topic-card-heading"><strong>{topic.title}</strong><span aria-hidden="true">→</span></div>
      <p>{topic.summary || "No summary yet."}</p>
      <small>{fileCount} file{fileCount === 1 ? "" : "s"} · {formatEnglishDate(topic.updatedAt)}</small>
    </button>
    <TagList tags={topic.tags} onTagClick={onTagClick} />
  </article>;
}

export function sortTopicFiles(files: any[], sort: FileSort) {
  return [...files].sort((left, right) => {
    if (left.path === "context.md") return -1;
    if (right.path === "context.md") return 1;
    if (sort === "name") return left.path.localeCompare(right.path);
    return String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")) || left.path.localeCompare(right.path);
  });
}

function TopicWorkspace({ api, topic, path, liveRevision, onBack, onChanged, onDirtyChange, onOpenDocument, onDeletedFile, onDeletedTopic, onTagClick }: { api: ApiClient; topic: string; path: string; liveRevision: number; onBack(): void; onChanged(): void; onDirtyChange(dirty: boolean): void; onOpenDocument(topic: string, path?: string, title?: string): void; onDeletedFile(): void; onDeletedTopic(): void; onTagClick(tag: string): void }) {
  const [revision, setRevision] = useState(0);
  const overview = useLoad<any>(() => api.get(`/topics/${encodeURIComponent(topic)}/overview`), [api, topic, revision, liveRevision]);
  const [file, setFile] = useState<any>();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [conflict, setConflict] = useState<any>();
  const [showMetadata, setShowMetadata] = useState(false);
  const [showNewFile, setShowNewFile] = useState(false);
  const [showCatalogue, setShowCatalogue] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<"file" | "topic">();
  const [showContext, setShowContext] = useState(true);
  const [fileSort, setFileSort] = useState<FileSort>(() => window.localStorage.getItem("topical.file-sort") === "name" ? "name" : "recent");
  const preview = useRef<HTMLDivElement>(null);
  const fileRef = useRef<any>(undefined);
  const draftRef = useRef("");
  const dirtyRef = useRef(false);

  const dirty = Boolean(file && draft !== file.content);
  fileRef.current = file;
  draftRef.current = draft;
  dirtyRef.current = dirty;
  useEffect(() => {
    let active = true;
    api.get(`/topic-file${queryString({ topic, path })}`).then((value) => {
      if (!active) return;
      setFile(value); setDraft(value.content); setEditing(false); setDescription("");
    }).catch((error) => active && setNotice({ kind: "error", text: errorMessage(error) }));
    return () => { active = false; };
  }, [api, topic, path, revision]);
  useEffect(() => {
    let active = true;
    api.get(`/topic-file${queryString({ topic, path })}`).then((current) => {
      if (!active || !fileRef.current || current.hash === fileRef.current.hash) return;
      if (dirtyRef.current) {
        setConflict({ current, draft: draftRef.current, external: true });
      } else {
        setFile(current);
        setDraft(current.content);
        setNotice({ kind: "success", text: "Updated from a change made outside this browser." });
      }
    }).catch((error) => active && setNotice({ kind: "error", text: errorMessage(error) }));
    return () => { active = false; };
  }, [api, topic, path, liveRevision]);
  useEffect(() => { setNotice(null); }, [topic, path]);
  useEffect(() => { window.localStorage.setItem("topical.file-sort", fileSort); }, [fileSort]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty]);

  const save = async () => {
    if (!description.trim()) { setNotice({ kind: "error", text: "Describe the change before saving." }); return; }
    try {
      const result = await api.send("PATCH", "/topic-file", { topic, filePath: path, mode: "replace", content: draft, expectedHash: file.hash, description });
      setFile({ ...file, content: draft, hash: result.hash });
      setDescription(""); setEditing(false); setNotice({ kind: "success", text: "Saved with conflict protection and an audit entry." });
      setRevision((value) => value + 1); onChanged();
    } catch (error) {
      if (error instanceof ApiError && error.code === "CONFLICT") {
        const current = await api.get(`/topic-file${queryString({ topic, path })}`);
        setConflict({ current, draft, details: error.details });
      } else setNotice({ kind: "error", text: errorMessage(error) });
    }
  };

  const deleteFile = async (change: string) => {
    try {
      await api.send("DELETE", "/topic-file", { topic, filePath: path, expectedHash: file.hash, description: change });
      setPendingDelete(undefined); onChanged(); onDeletedFile();
    } catch (error) { setNotice({ kind: "error", text: errorMessage(error) }); throw error; }
  };

  const deleteTopic = async (change: string) => {
    try {
      await api.send("DELETE", "/topic", { topic, expectedHash: contextHash, description: change });
      setPendingDelete(undefined); onDeletedTopic();
    } catch (error) { setNotice({ kind: "error", text: errorMessage(error) }); throw error; }
  };

  if (overview.error) return <main className="surface"><InlineError text={overview.error} /></main>;
  if (notice?.kind === "error" && !file) return <main className="surface"><InlineError text={notice.text} /></main>;
  if (overview.loading || !overview.data || !file) return <main className="surface"><Loading /></main>;
  const metadata = overview.data.metadata;
  const contextHash = overview.data.files.find((item: any) => item.path === "context.md")?.hash;
  const sortedFiles = sortTopicFiles(overview.data.files, fileSort);
  return (
    <main className={`workspace ${showContext ? "" : "context-hidden"}`}>
      <section className="document-pane">
        <PageHeader eyebrow={<button className="text-button" onClick={onBack}>← Topics</button>} title={metadata.title} subtitle={metadata.summary} actions={<><button onClick={() => setShowMetadata(true)}>Edit details</button><button className={editing ? "" : "primary"} onClick={() => setEditing((value) => !value)}>{editing ? "Read" : "Edit"}</button></>} />
        {notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}
        {editing ? (
          <div className="edit-layout">
            <div><div className="section-label">Markdown source</div><MarkdownEditor value={draft} onChange={setDraft} onScrollRatio={(ratio) => { const node = preview.current; if (node) node.scrollTop = ratio * Math.max(0, node.scrollHeight - node.clientHeight); }} /></div>
            <div><div className="section-label live-preview-label"><span>Live safe preview</span><small aria-live="polite">{draft.length.toLocaleString()} characters</small></div><div className="preview-scroll" ref={preview}><MarkdownView>{draft}</MarkdownView></div></div>
          </div>
        ) : <MarkdownView>{file.content}</MarkdownView>}
        {editing && <div className="save-bar"><input aria-label="Change description" placeholder="Describe this change for the audit history" value={description} onChange={(event) => setDescription(event.target.value)} /><span>{dirty ? "Unsaved changes" : "No changes"}</span><button onClick={() => { setDraft(file.content); setEditing(false); }}>Cancel</button><button className="primary" disabled={!dirty} onClick={save}>Save safely</button></div>}
      </section>
      {showContext && <aside className="context-pane" aria-label="Topic sidebar">
        <div className="context-heading"><span>Files</span><div className="context-actions"><button className="icon-button" aria-label="Inspect topic catalogue" title="Inspect topic catalogue" onClick={() => setShowCatalogue(true)}>{"{}"}</button><button className="icon-button" aria-label="Create supporting file" onClick={() => setShowNewFile(true)}>＋</button><button className="icon-button panel-toggle" aria-label="Hide topic sidebar" title="Hide topic sidebar" onClick={() => setShowContext(false)}>→</button></div></div>
        <label className="file-sort">Sort supporting files<select aria-label="Sort topic files" value={fileSort} onChange={(event) => setFileSort(event.target.value as FileSort)}><option value="recent">Recently updated</option><option value="name">Name A–Z</option></select></label>
        <div className="file-list">
          {sortedFiles.map((item: any) => <button key={item.path} className={path === item.path ? "active" : ""} onClick={() => onOpenDocument(topic, item.path, metadata.title)}><span aria-hidden="true">◇</span><span className="file-label"><strong>{item.path}</strong><small>Updated {formatEnglishDate(item.updatedAt)}</small></span></button>)}
        </div>
        <div className="context-section"><span className="section-label">Tags</span><TagList tags={metadata.tags} onTagClick={onTagClick} /></div>
        <div className="context-section"><span className="section-label">File hash</span><code className="hash">{file.hash}</code></div>
        <TopicHistory api={api} topic={topic} revision={revision + liveRevision} onOpenFile={onOpenDocument} />
        {path !== "context.md" && <button className="danger subtle" onClick={() => setPendingDelete("file")}>Move file to trash</button>}
        <button className="danger subtle" onClick={() => setPendingDelete("topic")}>Move topic to trash</button>
      </aside>}
      {!showContext && <button className="show-context-button" aria-label="Show topic sidebar" title="Show topic sidebar" onClick={() => setShowContext(true)}><span aria-hidden="true">←</span><span>Topic details</span></button>}
      {conflict && <ConflictDialog conflict={conflict} onClose={() => setConflict(null)} onReload={() => { setFile(conflict.current); setDraft(conflict.current.content); setConflict(null); }} onReview={() => { setFile(conflict.current); setConflict(null); setNotice({ kind: "success", text: "Current version reviewed. Reconcile the draft, then save explicitly." }); }} />}
      {showMetadata && <MetadataDialog api={api} topic={topic} metadata={metadata} expectedHash={contextHash} onClose={() => setShowMetadata(false)} onSaved={() => { setShowMetadata(false); setRevision((value) => value + 1); onChanged(); }} />}
      {showNewFile && <NewFileDialog api={api} topic={topic} onClose={() => setShowNewFile(false)} onCreated={(createdPath: string) => { setShowNewFile(false); setRevision((value) => value + 1); onOpenDocument(topic, createdPath, metadata.title); onChanged(); }} />}
      {showCatalogue && <CatalogueInspector api={api} topic={topic} onClose={() => setShowCatalogue(false)} />}
      {pendingDelete === "file" && <ReasonDialog title={`Move ${path} to trash?`} detail="The file remains recoverable in Topical trash." action="Move file to trash" onClose={() => setPendingDelete(undefined)} onSubmit={deleteFile} />}
      {pendingDelete === "topic" && <ReasonDialog title={`Move ${metadata.title} to trash?`} detail="The entire topic remains recoverable in Topical trash." action="Move topic to trash" onClose={() => setPendingDelete(undefined)} onSubmit={deleteTopic} />}
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
  const [name, setName] = useState(""); const [description, setDescription] = useState(""); const [error, setError] = useState<string>();
  const filePath = markdownPathForName(name);
  const title = (filePath.split("/").at(-1) || "New note").replace(/\.md$/i, "").replaceAll(/[-_]+/g, " ").trim() || "New note";
  const content = `# ${title.charAt(0).toUpperCase()}${title.slice(1)}\n\n`;
  const submit = async (event: FormEvent) => { event.preventDefault(); try { await api.send("POST", "/topic-files", { topic, filePath, content, description }); onCreated(filePath); } catch (reason) { setError(errorMessage(reason)); } };
  return <Dialog title="Create supporting file" onClose={onClose}><form className="form-stack" onSubmit={submit}><label>File name<input autoFocus placeholder="research/observations" value={name} onChange={(event) => setName(event.target.value)} required /></label><div className="path-preview"><span>Will create</span><code>{filePath || "note.md"}</code></div><label>Change description<input value={description} onChange={(event) => setDescription(event.target.value)} required minLength={3} /></label>{error && <InlineError text={error} />}<div className="dialog-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={!filePath}>Create file</button></div></form></Dialog>;
}

export function markdownPathForName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) return "";
  return trimmed.replace(/\.md$/i, "") + ".md";
}

function CreateTopic({ api, onClose, onCreated }: any) {
  const [title, setTitle] = useState(""); const [summary, setSummary] = useState(""); const [tagText, setTagText] = useState(""); const [content, setContent] = useState(""); const [description, setDescription] = useState(""); const [error, setError] = useState<string>();
  const submit = async (event: FormEvent) => { event.preventDefault(); try { const result = await api.send("POST", "/topics", { title, summary, tags: tagText.split(",").map((item) => item.trim()).filter(Boolean), initialContent: content, description }); onCreated(result.topic); } catch (reason) { setError(errorMessage(reason)); } };
  return <Dialog title="Create topic" onClose={onClose}><form className="form-stack" onSubmit={submit}><label>Title<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} required /></label><label>Summary<textarea value={summary} onChange={(event) => setSummary(event.target.value)} /></label><label>Tags<input placeholder="optional, sparse, recurring" value={tagText} onChange={(event) => setTagText(event.target.value)} /></label><label>Initial Markdown<textarea rows={8} value={content} onChange={(event) => setContent(event.target.value)} /></label><label>Change description<input value={description} onChange={(event) => setDescription(event.target.value)} required minLength={3} /></label>{error && <InlineError text={error} />}<div className="dialog-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary">Create topic</button></div></form></Dialog>;
}

function SearchView({ api, onOpen, onTagClick, request, liveRevision }: { api: ApiClient; onOpen(topic: string, path?: string, title?: string): void; onTagClick(tag: string): void; request: { query: string; key: number }; liveRevision: number }) {
  const [query, setQuery] = useState(request.query); const [submitted, setSubmitted] = useState(request.query); const [result, setResult] = useState<any>(); const [error, setError] = useState<string>();
  const runSearch = async (next: string) => { if (!next.trim()) return; setSubmitted(next); setError(undefined); try { setResult(await api.get(`/search${queryString({ q: next, limit: 20 })}`)); } catch (reason) { setError(errorMessage(reason)); } };
  const search = async (event: FormEvent) => { event.preventDefault(); await runSearch(query); };
  useEffect(() => { if (request.query) { setQuery(request.query); void runSearch(request.query); } }, [request.key]);
  useEffect(() => { if (submitted) void runSearch(submitted); }, [liveRevision]);
  return <main className="surface"><PageHeader eyebrow="Retrieval" title="Search" subtitle="Topic-grouped, strict first, with every widening step visible." /><form className="search-bar" onSubmit={search}><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search titles, tags, headings, and Markdown…" /><button className="primary">Search</button></form>{error && <InlineError text={error} />}{result && <><div className="result-summary"><ModeBadge mode={result.matchMode} /><span>{result.topics.length} topic{result.topics.length === 1 ? "" : "s"}</span>{result.analysis?.ignoredTerms?.length ? <span>{result.analysis.ignoredTerms.length} ignored term(s)</span> : null}</div><div className="result-list">{result.topics.map((item: any) => <article className="result-card" key={item.topic}><button className="result-card-main" onClick={() => onOpen(item.topic, item.files?.[0]?.path || "context.md", item.title)} aria-label={`Open ${item.title}`}><strong>{item.title}</strong><p>{item.files?.[0]?.snippet || item.summary}</p><small>{(item.matchedFields || []).join(" · ")}{item.files?.[0]?.path ? ` · ${item.files[0].path}` : ""}</small></button><TagList tags={item.tags} onTagClick={onTagClick} /></article>)}</div>{!result.topics.length && <EmptyState title={`No results for “${submitted}”`} detail="Topical exhausted exact and approved bounded fallback modes." />}</>}</main>;
}

export function TagsView({ api, liveRevision = 0, onTagClick }: { api: ApiClient; liveRevision?: number; onTagClick?(tag: string): void }) {
  const data = useLoad<any>(() => api.get("/tags?limit=100"), [api, liveRevision]);
  const warnings = data.data?.warnings;
  return <main className="surface"><PageHeader eyebrow="Taxonomy" title="Tags" subtitle="Guidance and warnings only. Authored metadata is never rewritten automatically." />{data.loading && <Loading />}{data.error && <InlineError text={data.error} />}<div className="table-list">{(data.data?.tags || []).map((item: any) => { const display = item.displayForms?.[0] || item.key; return <div className="table-row" key={item.key}><div>{onTagClick ? <button className="tag-heading" onClick={() => onTagClick(display)}>#{display}</button> : <strong>#{display}</strong>}<small>{item.displayForms?.length > 1 ? `Also written as ${item.displayForms.slice(1).join(", ")}` : item.topics?.join(" · ") || "Recurring facet"}</small></div><span>{item.usageCount} topic{item.usageCount === 1 ? "" : "s"}</span></div>; })}</div>{warnings && <div className="warning-grid"><TaxonomyWarning title="Singleton tags" count={warnings.singletonSummary?.count} detail={warnings.singletonSummary?.sampleKeys?.join(", ")} /><TaxonomyWarning title="Display variants" count={warnings.variants?.length} detail={warnings.variants?.map((item: any) => item.key).join(", ")} /><TaxonomyWarning title="Comparison collisions" count={warnings.comparisonCollisions?.length} detail={warnings.comparisonCollisions?.map((item: any) => item.keys.join(" / ")).join(", ")} /><TaxonomyWarning title="Near duplicates" count={warnings.nearDuplicates?.length} detail={warnings.nearDuplicates?.map((item: any) => item.keys.join(" / ")).join(", ")} /><TaxonomyWarning title="Above three-tag guidance" count={warnings.overGuidance?.count} detail={warnings.overGuidance?.topics?.map((item: any) => item.topic).join(", ")} /></div>}</main>;
}

function TaxonomyWarning({ title, count = 0, detail }: { title: string; count?: number; detail?: string }) {
  return <div className="health-card"><small>{title}</small><strong>{count}</strong>{detail && <p>{detail}</p>}</div>;
}

export function currentHistoryPath(event: any) {
  if (!event?.topic || event.action === "delete_topic" || event.action === "delete_file") return undefined;
  return event.path || "context.md";
}

function HistoryView({ api, liveRevision, onOpenFile }: { api: ApiClient; liveRevision: number; onOpenFile(topic: string, path?: string): void }) {
  const data = useLoad<any>(() => api.get("/history?limit=100"), [api, liveRevision]);
  return <main className="surface"><PageHeader eyebrow="Audit" title="History" subtitle="Recorded mutations. Available entries open the current file; historical line diffs are not available." />{data.loading && <Loading />}{data.error && <InlineError text={data.error} />}<div className="timeline">{(data.data?.events || []).map((event: any, index: number) => { const target = currentHistoryPath(event); return <div className="timeline-item" key={`${event.at}-${index}`}><span /><div>{target ? <button className="history-link" onClick={() => onOpenFile(event.topic, target)} title="Open the current file"><strong>{event.description}</strong><p>{event.topic} / {target} · {event.action}</p><small>{formatEnglishDate(event.at, { includeTime: true })}</small></button> : <><strong>{event.description}</strong><p>{event.topic}{event.path ? ` / ${event.path}` : ""} · {event.action}</p><small>{formatEnglishDate(event.at, { includeTime: true })} · current file unavailable</small></>}</div></div>; })}</div></main>;
}

function TrashView({ api, liveRevision }: { api: ApiClient; liveRevision: number }) {
  const [revision, setRevision] = useState(0); const [notice, setNotice] = useState<Notice>(null);
  const data = useLoad<any>(() => api.get("/trash?limit=100"), [api, revision, liveRevision]);
  const restore = async (entry: any) => { const description = window.prompt(`Describe why ${entry.topic}${entry.path ? `/${entry.path}` : ""} is being restored:`); if (!description) return; try { await api.send("POST", `/trash/${entry.id}/restore`, { expectedHash: entry.hash, description }); setNotice({ kind: "success", text: "Restored from trash." }); setRevision((value) => value + 1); } catch (error) { setNotice({ kind: "error", text: errorMessage(error) }); } };
  return <main className="surface"><PageHeader eyebrow="Recovery" title="Trash" subtitle="Soft-deleted files and topics remain recoverable; Topical never purges them automatically." />{notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}{data.loading && <Loading />}{data.error && <InlineError text={data.error} />}<div className="table-list">{(data.data?.entries || []).map((entry: any) => <div className="table-row" key={entry.id}><div><strong>{entry.topic}{entry.path ? ` / ${entry.path}` : ""}</strong><small>{entry.type} · {formatEnglishDate(entry.trashedAt, { includeTime: true })} · {entry.description}</small></div><button onClick={() => restore(entry)}>Restore</button></div>)}</div>{!data.loading && !data.data?.entries?.length && <EmptyState title="Trash is empty" detail="Deleted content will appear here with a recoverable hash." />}</main>;
}

function SystemView({ api, liveRevision }: { api: ApiClient; liveRevision: number }) {
  const [revision, setRevision] = useState(0); const [notice, setNotice] = useState<Notice>(null); const [showCatalogue, setShowCatalogue] = useState(false); const data = useLoad<any>(() => api.get("/health"), [api, revision, liveRevision]);
  const reindex = async () => { if (!window.confirm("Rebuild disposable derived indexes from authoritative Markdown?")) return; try { await api.send("POST", "/reindex", { description: "Rebuilt derived indexes from the management UI." }); setNotice({ kind: "success", text: "Derived indexes rebuilt from Markdown." }); setRevision((value) => value + 1); } catch (error) { setNotice({ kind: "error", text: errorMessage(error) }); } };
  return <main className="surface"><PageHeader eyebrow="Diagnostics" title="System" subtitle="Markdown authority and disposable derived-state health." actions={<><button onClick={() => setShowCatalogue(true)}>Inspect root catalogue</button><button onClick={reindex}>Reindex</button></>} />{notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}{data.loading && <Loading />}{data.error && <InlineError text={data.error} />}{data.data && <div className="health-grid">{Object.entries(data.data).map(([key, value]) => <div className="health-card" key={key}><small>{key.replace(/[A-Z]/g, (match) => ` ${match}`).toUpperCase()}</small><strong>{typeof value === "object" ? ((value as any)?.status || "Ready") : String(value)}</strong><pre>{typeof value === "object" ? JSON.stringify(value, null, 2) : ""}</pre></div>)}</div>}{showCatalogue && <CatalogueInspector api={api} onClose={() => setShowCatalogue(false)} />}</main>;
}

function PublicationsView({ api, topics, liveRevision }: { api: ApiClient; topics: any[]; liveRevision: number }) {
  const [revision, setRevision] = useState(0); const [selected, setSelected] = useState<string>(); const [detail, setDetail] = useState<any>(); const [notice, setNotice] = useState<Notice>(null); const [showCreate, setShowCreate] = useState(false); const [showUpdate, setShowUpdate] = useState(false);
  const [showForget, setShowForget] = useState(false);
  const data = useLoad<any>(() => api.get("/publications?limit=100"), [api, revision, liveRevision]);
  useEffect(() => { if (selected) api.get(`/publications/${selected}`).then(setDetail).catch((error) => setNotice({ kind: "error", text: errorMessage(error) })); }, [api, selected, revision, liveRevision]);
  const forget = async (description: string) => { if (!detail) return; try { await api.send("DELETE", `/publications/${detail.record.id}`, { description }); setShowForget(false); setSelected(undefined); setDetail(undefined); setRevision((value) => value + 1); } catch (error) { setNotice({ kind: "error", text: errorMessage(error) }); throw error; } };
  return <main className="surface"><PageHeader eyebrow="Checkpoints" title="Publications" subtitle="Explicit independent Markdown checkpoints—never automatic synchronization." actions={<button className="primary" onClick={() => setShowCreate(true)}>New publication</button>} />{notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}{data.loading && <Loading />}{data.error && <InlineError text={data.error} />}<div className="split-list"><div className="table-list">{(data.data?.publications || []).map((item: any) => <button className={`table-row ${selected === item.id ? "selected" : ""}`} key={item.id} onClick={() => setSelected(item.id)}><div><strong>{item.label || item.destination.path}</strong><small>{item.topic} · {item.destination.alias}/{item.destination.path}</small></div><ModeBadge mode={item.state} /></button>)}</div>{detail && <section className="publication-detail"><div className="section-label">Relationship state</div><h2>{detail.record.label || detail.record.destination.path}</h2><ModeBadge mode={detail.status.state} /><p>{detail.status.guidance?.message}</p><div className="section-label">Current destination</div>{detail.currentContent === null ? <p>Destination unavailable or missing.</p> : <MarkdownView>{detail.currentContent}</MarkdownView>}<div className="dialog-actions"><button className="danger subtle" onClick={() => setShowForget(true)}>Forget relationship</button><button disabled={!detail.status.currentTargetHash} onClick={() => setShowUpdate(true)}>Update checkpoint</button></div></section>}</div>{showCreate && <CreatePublication api={api} topics={topics} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); setRevision((value) => value + 1); }} />}{showUpdate && detail && <UpdatePublication api={api} detail={detail} onClose={() => setShowUpdate(false)} onUpdated={() => { setShowUpdate(false); setRevision((value) => value + 1); }} />}{showForget && detail && <ReasonDialog title="Forget this publication relationship?" detail="The destination document remains unchanged and independent." action="Forget relationship" onClose={() => setShowForget(false)} onSubmit={forget} />}</main>;
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

function TopicHistory({ api, topic, revision, onOpenFile }: { api: ApiClient; topic: string; revision: number; onOpenFile(topic: string, path?: string): void }) {
  const [limit, setLimit] = useState(8);
  const data = useLoad<any>(() => api.get(`/history${queryString({ topic, limit })}`), [api, topic, limit, revision]);
  return <div className="context-section topic-history"><span className="section-label">Topic history</span>{data.loading && !data.data && <Loading />}{data.error && <InlineError text={data.error} />}{(data.data?.events || []).map((event: any, index: number) => { const target = currentHistoryPath(event); return target ? <button className="mini-history history-link" title="Open the current file" key={`${event.at}-${event.action}-${index}`} onClick={() => onOpenFile(topic, target)}><strong>{event.description}</strong><small>{event.action.replaceAll("_", " ")} · {target}<br />{formatEnglishDate(event.at, { includeTime: true })}</small></button> : <div className="mini-history" key={`${event.at}-${event.action}-${index}`}><strong>{event.description}</strong><small>{event.action.replaceAll("_", " ")}{event.path ? ` · ${event.path}` : ""}<br />{formatEnglishDate(event.at, { includeTime: true })} · unavailable</small></div>; })}{data.data?.page?.nextCursor && <button className="subtle" onClick={() => setLimit((value) => Math.min(100, value + 12))}>Load more</button>}</div>;
}

function CatalogueInspector({ api, topic, onClose }: { api: ApiClient; topic?: string; onClose(): void }) {
  const [mode, setMode] = useState<"rendered" | "raw">("rendered");
  const [copied, setCopied] = useState(false);
  const data = useLoad<any>(() => api.get(topic ? `/catalogues/topic${queryString({ topic, view: mode })}` : `/catalogues/root${queryString({ view: mode })}`), [api, topic, mode]);
  const label = topic ? `${topic} topic catalogue` : "Root catalogue";
  const copy = async () => { await navigator.clipboard.writeText(data.data.raw); setCopied(true); };
  const download = () => {
    const url = URL.createObjectURL(new Blob([data.data.raw], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = topic ? `${topic}-index.json` : "topical-root-index.json"; link.click();
    URL.revokeObjectURL(url);
  };
  return <Dialog title={label} onClose={onClose}><p className="catalogue-note">Read-only disposable derived state. Markdown remains authoritative, and reindexing can rebuild this file.</p><div className="inspector-tabs" role="tablist" aria-label="Catalogue display"><button role="tab" aria-selected={mode === "rendered"} className={mode === "rendered" ? "active" : ""} onClick={() => setMode("rendered")}>Rendered</button><button role="tab" aria-selected={mode === "raw"} className={mode === "raw" ? "active" : ""} onClick={() => { setMode("raw"); setCopied(false); }}>Raw JSON</button></div>{data.loading && <Loading />}{data.error && <InlineError text={data.error} />}{data.data && <><div className="catalogue-meta"><span>{data.data.size.toLocaleString()} bytes</span><code>{data.data.hash}</code>{mode === "raw" && <div className="catalogue-actions"><button onClick={copy}>{copied ? "Copied" : "Copy JSON"}</button><button onClick={download}>Download JSON</button></div>}</div>{mode === "raw" ? <pre className="raw-catalogue">{data.data.raw}</pre> : <RenderedCatalogue value={data.data.data} topic={topic} />}</>}</Dialog>;
}

function RenderedCatalogue({ value, topic }: { value: any; topic?: string }) {
  const documents = value.documents || [];
  const history = value.history || value.recentActions || [];
  return <div className="rendered-catalogue"><div className="health-grid"><div className="health-card"><small>Schema version</small><strong>{value.version ?? "Unknown"}</strong></div><div className="health-card"><small>{topic ? "Files" : "Topics"}</small><strong>{topic ? (value.files?.length || documents.length) : (value.topics?.length || 0)}</strong></div><div className="health-card"><small>Documents</small><strong>{documents.length}</strong></div><div className="health-card"><small>Actions</small><strong>{history.length}</strong></div></div>{value.topic && <section><h3>Topic metadata</h3><pre>{JSON.stringify(value.topic, null, 2)}</pre></section>}{value.topics?.length ? <CatalogueRows title="Topics" rows={value.topics} /> : null}{documents.length ? <CatalogueRows title="Documents" rows={documents} /> : null}{history.length ? <CatalogueRows title={value.history ? "History" : "Recent actions"} rows={history} /> : null}</div>;
}

function CatalogueRows({ title, rows }: { title: string; rows: any[] }) {
  const [page, setPage] = useState(0);
  const pageSize = 25;
  const start = page * pageSize;
  const shown = rows.slice(start, start + pageSize);
  return <section><h3>{title}</h3><div className="catalogue-rows">{shown.map((row, index) => <pre key={`${start + index}-${row.id || row.path || row.at || "row"}`}>{JSON.stringify(row, null, 2)}</pre>)}</div>{rows.length > pageSize && <div className="pagination"><button disabled={page === 0} onClick={() => setPage((value) => value - 1)}>Previous</button><span>{start + 1}–{Math.min(rows.length, start + pageSize)} of {rows.length}</span><button disabled={start + pageSize >= rows.length} onClick={() => setPage((value) => value + 1)}>Next</button></div>}</section>;
}

function ReasonDialog({ title, detail, action, onClose, onSubmit }: { title: string; detail: string; action: string; onClose(): void; onSubmit(description: string): Promise<void> }) {
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true); setError(undefined);
    try { await onSubmit(description.trim()); } catch (reason) { setError(errorMessage(reason)); setSubmitting(false); }
  };
  return <Dialog title={title} onClose={onClose}><p>{detail}</p><form className="form-stack" onSubmit={submit}><label>Reason<input autoFocus value={description} onChange={(event) => setDescription(event.target.value)} required minLength={3} /></label>{error && <InlineError text={error} />}<div className="dialog-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary danger-action" disabled={submitting || description.trim().length < 3}>{submitting ? "Working…" : action}</button></div></form></Dialog>;
}

function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose(): void }) {
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><section className="dialog" role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button className="icon-button" aria-label="Close" onClick={onClose}>×</button></header>{children}</section></div>;
}

function ModeBadge({ mode }: { mode: string }) { return <span className={`mode mode-${String(mode).replaceAll("_", "-")}`}>{String(mode).replaceAll("_", " ")}</span>; }
function TagList({ tags = [], onTagClick }: { tags?: string[]; onTagClick?(tag: string): void }) { return <div className="tag-list">{tags.map((tag) => onTagClick ? <button type="button" className="tag-pill" aria-label={`Show topics tagged ${tag}`} key={tag} onClick={() => onTagClick(tag)}>#{tag}</button> : <span key={tag}>#{tag}</span>)}</div>; }
function Loading() { return <div className="loading"><span />Loading…</div>; }
function InlineError({ text }: { text: string }) { return <div className="notice error">{text}</div>; }
function EmptyState({ title, detail }: { title: string; detail: string }) { return <section className="empty-state"><div className="empty-mark">◇</div><h2>{title}</h2><p>{detail}</p></section>; }
