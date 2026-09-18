import { useEffect, useRef, useState } from "react";
import { ApiClient, queryString } from "./api";

type Task = { topic: string; topicTitle: string; path: string; sourceHash: string; offset: number; line: number; text: string; heading: string; completed: boolean };
type TaskPage = { tasks: Task[]; counts: { total: number; open: number; completed: number; topics: number }; page: { total: number; nextCursor: string | null }; freshness: { indexedAt: string } };

export function TasksView({ api, initialTopic = "", initialPath = "", liveRevision = 0, onOpen, onChanged }: { api: ApiClient; initialTopic?: string; initialPath?: string; liveRevision?: number; onOpen(topic: string, path?: string, title?: string): void; onChanged?(): void }) {
  const [topic, setTopic] = useState(initialTopic);
  const [pathPrefix, setPathPrefix] = useState(initialPath);
  const [status, setStatus] = useState("open");
  const [cursor, setCursor] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<TaskPage>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [topicOptions, setTopicOptions] = useState<{ id: string; title: string }[]>([]);
  const [topicCursor, setTopicCursor] = useState<string>();
  const [nextTopicCursor, setNextTopicCursor] = useState<string>();
  const [topicError, setTopicError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    let active = true;
    api.get(`/topics${queryString({ sort: "title", limit: 50, cursor: topicCursor })}`).then((result) => {
      if (!active) return;
      setTopicOptions((previous) => {
        const items = [...(topicCursor ? previous : []), ...(result.topics || [])];
        return [...new Map(items.map((item) => [item.id, item])).values()];
      });
      setNextTopicCursor(result.page?.nextCursor || undefined);
      setTopicError("");
    }).catch(() => { if (active) setTopicError("Topic choices could not be loaded. Global tasks are still available."); });
    return () => { active = false; };
  }, [api, topicCursor]);
  useEffect(() => {
    const request = ++generation.current;
    setLoading(true); setData(undefined);
    api.get<TaskPage>(`/tasks${queryString({ topic, pathPrefix, status, cursor, limit: 50 })}`)
      .then((value) => { if (request === generation.current) setData(value); })
      .catch((reason) => { if (request === generation.current) setError(reason.message); })
      .finally(() => { if (request === generation.current) setLoading(false); });
    return () => { generation.current += 1; };
  }, [api, topic, pathPrefix, status, cursor, revision, liveRevision]);
  const refresh = () => { setCursor(undefined); setRevision((value) => value + 1); };
  const toggle = async (task: Task) => {
    setBusy(true); setError("");
    try {
      await api.send("PATCH", "/task", { topic: task.topic, filePath: task.path, offset: task.offset, completed: !task.completed, expectedHash: task.sourceHash, description: `${task.completed ? "Reopened" : "Completed"} task at ${task.path}:${task.line}.` });
      refresh(); onChanged?.();
    } catch (reason) {
      setError(`${reason instanceof Error ? reason.message : "Task could not be updated."} Refresh and review the source before retrying.`);
    } finally { setBusy(false); }
  };
  return <section className="surface tasks-view" aria-label="Tasks">
    <div className="page-header"><div><h1>Tasks</h1><p>Actions from your Markdown, linked to their owning context.</p></div><button disabled={busy || loading} onClick={() => { setError(""); refresh(); }}>Refresh tasks</button></div>
    <div className="browser-toolbar">
      <label>Topic<select value={topic} onChange={(event) => { setTopic(event.target.value); setCursor(undefined); setError(""); }}><option value="">All topics</option>{topic && !topicOptions.some((item) => item.id === topic) && <option value={topic}>{topic}</option>}{topicOptions.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
      {nextTopicCursor && <button onClick={() => setTopicCursor(nextTopicCursor)}>Load more topics</button>}
      <label>Work-area path<input value={pathPrefix} placeholder="All files, or issues/inc-042" onChange={(event) => { setPathPrefix(event.target.value); setCursor(undefined); setError(""); }} /></label>
      <label>Status<select value={status} onChange={(event) => { setStatus(event.target.value); setCursor(undefined); }}><option value="open">Open</option><option value="completed">Completed</option><option value="all">All</option></select></label>
    </div>
    {error && <p role="alert" className="notice error">{error}</p>}
    {topicError && <p role="status">{topicError}</p>}
    {loading && <p role="status">Loading tasks…</p>}
    {busy && <p role="status">Saving task…</p>}
    {data && <>
      <p role="status">{data.counts.open} open · {data.counts.completed} completed · {data.counts.topics} topics</p>
      <p className="tasks-freshness">External Markdown edits appear after reindexing in System. Refresh reloads the current index.</p>
      {!data.tasks.length && <p>No {status === "all" ? "" : status + " "}tasks in this scope.</p>}
      <div className="table-list">{data.tasks.map((task) => <div className="task-row" key={`${task.topic}:${task.path}:${task.offset}`}>
        <input type="checkbox" aria-label={`${task.completed ? "Reopen" : "Complete"}: ${task.text}`} checked={task.completed} disabled={busy || loading} onChange={() => void toggle(task)} />
        <div><strong>{task.text}</strong><small>{task.topicTitle} · {task.path}:{task.line}{task.heading ? ` · ${task.heading}` : ""}</small></div>
        <button onClick={() => onOpen(task.topic, task.path, task.topicTitle)}>Open source</button>
      </div>)}</div>
      <div className="dialog-actions">{cursor && <button disabled={busy || loading} onClick={() => setCursor(undefined)}>First page</button>}{data.page.nextCursor && <button disabled={busy || loading} onClick={() => setCursor(data.page.nextCursor!)}>Next tasks</button>}</div>
    </>}
  </section>;
}
