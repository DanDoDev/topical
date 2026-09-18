import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTaskListItemFromMarkdown } from "mdast-util-gfm-task-list-item";
import { gfmTaskListItem } from "micromark-extension-gfm-task-list-item";

// Mask frontmatter without changing UTF-16 source offsets or line numbers.
export function extractTasks(content) {
  if (!/\[[ xX]\]/.test(content)) return [];
  const source = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, (value) => value.replace(/[^\r\n]/g, " "));
  const tree = fromMarkdown(source, {
    extensions: [gfmTaskListItem()],
    mdastExtensions: [gfmTaskListItemFromMarkdown()]
  });
  if (tree.children.some((node) => node.type === "html" && node.value.trim() === "<!-- topical:tasks off -->")) return [];
  const tasks = [];
  let heading = "";
  const text = (node) => node.type === "text" || node.type === "inlineCode" ? node.value : (node.children || []).map(text).join("");
  function visit(node) {
    if (["blockquote", "code", "html"].includes(node.type)) return;
    if (node.type === "heading") heading = text(node);
    if (node.type === "listItem" && typeof node.checked === "boolean") {
      const start = node.position.start.offset;
      const prefix = source.slice(start, node.children[0]?.position.end.offset ?? node.position.end.offset);
      const match = /^(?:[-+*]|\d+[.)])[ \t]+\[([ xX])\]/.exec(prefix);
      if (match) tasks.push({
        offset: start + match[0].lastIndexOf("[") + 1,
        line: node.position.start.line,
        text: text(node.children[0]).trim().slice(0, 2000),
        heading: heading.slice(0, 300),
        completed: node.checked
      });
    }
    for (const child of node.children || []) visit(child);
  }
  visit(tree);
  return tasks;
}
