import { markdown } from "@codemirror/lang-markdown";
import { useEffect, useRef } from "react";
import { basicSetup, EditorView } from "codemirror";

export function MarkdownEditor({ value, onChange, onScrollRatio }: { value: string; onChange(value: string): void; onScrollRatio?(ratio: number): void }) {
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onScrollRef = useRef(onScrollRatio);
  onChangeRef.current = onChange;
  onScrollRef.current = onScrollRatio;

  useEffect(() => {
    if (!parent.current) return;
    const editor = new EditorView({
      doc: value,
      parent: parent.current,
      extensions: [
        basicSetup,
        markdown(),
        EditorView.lineWrapping,
        EditorView.domEventHandlers({
          scroll: (_event, current) => {
            const scroll = current.scrollDOM;
            const available = scroll.scrollHeight - scroll.clientHeight;
            onScrollRef.current?.(available > 0 ? scroll.scrollTop / available : 0);
          }
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        })
      ]
    });
    view.current = editor;
    return () => editor.destroy();
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === value) return;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
  }, [value]);

  return <div className="editor" ref={parent} aria-label="Markdown editor" />;
}
