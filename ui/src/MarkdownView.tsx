import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function hideTaskDirective() {
  return (tree: { children: { type: string; value?: string }[] }) => {
    tree.children = tree.children.filter((node) => node.type !== "html" || node.value?.trim() !== "<!-- topical:tasks off -->");
  };
}

export function resolveTopicLink(href: string | undefined, currentPath: string): string | null {
  if (!href || href.startsWith("#") || href.includes("?") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  let target: string;
  try { target = decodeURIComponent(href.split("#")[0]); } catch { return null; }
  if (!target || target.startsWith("/") || target.includes("\\") || /[\u0000-\u001f]/.test(target) || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  const parts = currentPath.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "..") { if (!parts.length) return null; parts.pop(); }
    else if (part && part !== ".") parts.push(part);
  }
  const resolved = parts.join("/");
  return resolved.endsWith(".md") ? resolved : null;
}

export function MarkdownView({ children, currentPath = "context.md", onOpenFile }: { children: string; currentPath?: string; onOpenFile?(path: string): void }) {
  const visibleMarkdown = children.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  return (
    <article className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, hideTaskDirective]}
        components={{
          a: ({ href, children: label }) => {
            const local = onOpenFile ? resolveTopicLink(href, currentPath) : null;
            return local ? <a href={href} onClick={(event) => { event.preventDefault(); onOpenFile?.(local); }}>{label}</a> : <a href={href} target="_blank" rel="noreferrer">{label}</a>;
          },
          input: (props) => <input {...props} disabled />
        }}
      >
        {visibleMarkdown}
      </ReactMarkdown>
    </article>
  );
}
