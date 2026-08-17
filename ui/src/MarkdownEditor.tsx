import { markdown } from "@codemirror/lang-markdown";
import { useEffect, useRef } from "react";
import { basicSetup, EditorView } from "codemirror";

export function MarkdownEditor({ value, onChange }: { value: string; onChange(value: string): void }) {
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!parent.current) return;
    const editor = new EditorView({
      doc: value,
      parent: parent.current,
      extensions: [
        basicSetup,
        markdown(),
        EditorView.lineWrapping,
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
