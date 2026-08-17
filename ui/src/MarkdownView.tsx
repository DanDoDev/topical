import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownView({ children }: { children: string }) {
  const visibleMarkdown = children.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  return (
    <article className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children: label }) => <a href={href} target="_blank" rel="noreferrer">{label}</a>,
          input: (props) => <input {...props} disabled />
        }}
      >
        {visibleMarkdown}
      </ReactMarkdown>
    </article>
  );
}
