import path from "node:path";
import { createHash } from "node:crypto";
import { fromMarkdown } from "mdast-util-from-markdown";
import { TopicalError } from "./errors.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const text = (node) => node.value ?? (node.children || []).map(text).join("");
const masked = (content) => content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, (value) => value.replace(/[^\r\n]/g, " "));
export function contextSections(content) {
  const tree = fromMarkdown(masked(content));
  const sections = [];
  const stack = [];
  for (const node of tree.children) {
    if (node.type !== "heading") continue;
    const start = node.position.start.offset;
    while (stack.length && stack.at(-1).depth >= node.depth) stack.pop().end = start;
    if (node.depth > 1) {
      const section = { start, end: content.length, line: node.position.start.line, title: text(node).slice(0, 300), depth: node.depth };
      sections.push(section); stack.push(section);
    }
  }
  return sections.map((section) => ({ ...section, characters: section.end - section.start }));
}

export function localMarkdownLinks(content) {
  const links = new Set();
  function visit(node) {
    if (typeof node.url === "string" && !/^(?:[a-z][a-z0-9+.-]*:|[\/#?])/i.test(node.url)) {
      try {
        const target = decodeURIComponent(node.url.split(/[?#]/)[0]);
        if (target.toLowerCase().endsWith(".md")) links.add(target);
      } catch { /* Invalid escaping is not a resolvable local path. */ }
    }
    for (const child of node.children || []) visit(child);
  }
  visit(fromMarkdown(masked(content)));
  return [...links];
}

// Rebase real Markdown destinations only, leaving prose, code and formatting intact.
function rebase(content, from, to) {
  const tree = fromMarkdown(content);
  const edits = [];
  function visit(node) {
    if (node.type === "html" && !/^\s*<!--[\s\S]*-->\s*$/.test(node.value)) throw new TopicalError("HTML elements need manual review before extracting this section.");
    if (typeof node.url === "string" && !/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(node.url)) {
      const raw = content.slice(node.position.start.offset, node.position.end.offset);
      let prefix;
      if (node.type === "definition") prefix = /^\[(?:\\.|[^\]])*\]:\s*/.exec(raw)?.[0].length;
      else {
        // Find the end of the label, respecting escaped/nested brackets (also images).
        let cursor = raw.startsWith("![") ? 2 : 1;
        let brackets = 1;
        while (cursor < raw.length && brackets) {
          if (raw[cursor] === "\\") { cursor += 2; continue; }
          if (raw[cursor] === "[") brackets++;
          if (raw[cursor] === "]") brackets--;
          cursor++;
        }
        const match = /^\(\s*/.exec(raw.slice(cursor));
        if (match) prefix = cursor + match[0].length;
      }
      if (prefix === undefined) throw new TopicalError("This link syntax needs manual review before extraction.");
      let end = prefix;
      if (raw[end] === "<") { end = raw.indexOf(">", end) + 1; }
      else {
        let depth = 0;
        while (end < raw.length) {
          if (raw[end] === "\\") { end += 2; continue; }
          if (/\s/.test(raw[end]) || (raw[end] === ")" && depth === 0)) break;
          if (raw[end] === "(") depth++;
          if (raw[end] === ")") depth--;
          end++;
        }
      }
      if (end < prefix) throw new TopicalError("This link destination needs manual review.");
      const [pathname] = node.url.split(/(?=[?#])/s, 2);
      // Fragment-only links refer back to the retained source headings.
      const fragmentOnly = /^[?#]/.test(node.url);
      let decoded;
      try { decoded = decodeURIComponent(fragmentOnly ? "" : pathname); } catch { throw new TopicalError("A link has invalid URL escaping."); }
      const target = decoded ? path.posix.normalize(path.posix.join(path.posix.dirname(from), decoded)) : from;
      if (target.startsWith("../") || target.includes("\\")) throw new TopicalError("A relative link escapes this topic; resolve it before extraction.");
      const relative = path.posix.relative(path.posix.dirname(to), target);
      const url = relative.split("/").map(encodeURIComponent).join("/") + (fragmentOnly ? node.url : node.url.slice(pathname.length));
      edits.push({ start: node.position.start.offset + prefix, end: node.position.start.offset + end, value: `<${url}>` });
    }
    for (const child of node.children || []) visit(child);
  }
  visit(tree);
  for (const edit of edits.sort((a, b) => b.start - a.start)) content = content.slice(0, edit.start) + edit.value + content.slice(edit.end);
  return content;
}

export function buildReorganization({ topic, source, extractions }) {
  if (!Array.isArray(extractions) || !extractions.length || extractions.length > 20) throw new TopicalError("Choose between one and twenty sections.");
  if (source.content.length > 250_000) throw new TopicalError("Reorganization previews support source files up to 250,000 characters. Split larger files manually first.");
  const sections = contextSections(source.content);
  const selected = extractions.map((item) => {
    const section = sections.find((candidate) => candidate.start === item.start);
    if (!section) throw new TopicalError("A selected section no longer exists. Analyze again.");
    return { ...section, path: item.destination };
  }).sort((a, b) => a.start - b.start);
  if (selected.some((item, i) => i && item.start < selected[i - 1].end)) throw new TopicalError("Select separate sections, not a section and its children.");
  if (new Set(selected.map((item) => item.path)).size !== selected.length) throw new TopicalError("Each section needs a different destination.");
  const tree = fromMarkdown(masked(source.content));
  const definitions = tree.children.filter((node) => node.type === "definition");
  function checkDefinitions(node) {
    for (const child of node.children || []) {
      if (child.type === "definition" && node !== tree) throw new TopicalError("Nested reference definitions need manual review before extraction.");
      checkDefinitions(child);
    }
  }
  checkDefinitions(tree);
  const tasksOff = tree.children.some((node) => node.type === "html" && node.value.trim() === "<!-- topical:tasks off -->");
  let after = source.content;
  const files = [];
  for (const item of [...selected].reverse()) {
    const original = source.content.slice(item.start, item.end);
    if (/^\[\^/m.test(original)) throw new TopicalError("Footnote definitions need manual review before extraction.");
    // Prepend definitions in their original order: first-definition-wins must not
    // change when an extracted section contains a duplicate identifier.
    const referenceDefinitions = definitions.map((node) => source.content.slice(node.position.start.offset, node.position.end.offset));
    const complete = (referenceDefinitions.length ? `${referenceDefinitions.join("\n\n")}\n\n` : "") + original;
    const content = (tasksOff ? "<!-- topical:tasks off -->\n\n" : "") + rebase(complete, source.path, item.path);
    const link = path.posix.relative(path.posix.dirname(source.path), item.path).split("/").map(encodeURIComponent).join("/");
    const headings = tree.children.filter((node) => node.type === "heading" && node.position.start.offset >= item.start && node.position.start.offset < item.end);
    const retainedDirective = tree.children.some((node) => node.type === "html" && node.value.trim() === "<!-- topical:tasks off -->" && node.position.start.offset >= item.start && node.position.start.offset < item.end) ? "<!-- topical:tasks off -->\n\n" : "";
    const stubs = retainedDirective + headings.map((node) => `${source.content.slice(node.position.start.offset, node.position.end.offset)}\n\n[Read supporting file](<${link}>)\n\n`).join("");
    const keptDefinitions = definitions.filter((node) => node.position.start.offset >= item.start && node.position.start.offset < item.end).map((node) => source.content.slice(node.position.start.offset, node.position.end.offset)).join("\n\n");
    after = after.slice(0, item.start) + stubs + (keptDefinitions ? keptDefinitions + "\n\n" : "") + after.slice(item.end);
    if (files.reduce((size, file) => size + file.content.length, content.length) > 1_000_000) throw new TopicalError("The supporting-file preview exceeds 1,000,000 characters. Select fewer sections.");
    files.unshift({ path: item.path, content, hash: digest(content), section: item.title });
  }
  const plan = { version: 1, topic, source: { path: source.path, hash: source.hash, before: source.content, after }, files };
  return { ...plan, previewHash: digest(JSON.stringify(plan)), summary: { beforeCharacters: source.content.length, afterCharacters: after.length, createdFiles: files.length }, guidance: "Review the source before/after and every new file. Apply preserves supporting files first; interrupted operations may leave duplicate tasks until explicitly recovered. No semantic summarization or stale-status inference is performed." };
}
