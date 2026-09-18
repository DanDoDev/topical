import { TopicalError } from "./errors.js";
import { fromMarkdown } from "mdast-util-from-markdown";

export const TOPIC_TEMPLATES = ["oncall", "project", "documentation", "planning"];
export const WORK_TYPES = ["issue", "plan", "draft"];

export function topicStarter(template, title, purpose = "") {
  if (!TOPIC_TEMPLATES.includes(template)) throw new TopicalError("Unknown topic template.");
  return `# ${title}\n\n## Purpose\n\n${purpose}\n\n## Current status\n\nWorking${template === "oncall" ? " — record the rotation and handoff here." : "."}\n\n## Active work\n\n## Next actions\n\n## Decisions and open questions\n`;
}

export function workStarter(kind, title, brief = "") {
  if (!WORK_TYPES.includes(kind)) throw new TopicalError("Unknown work type.");
  const sections = {
    issue: ["Known facts and impact", "Hypotheses and open questions", "Evidence", "Decisions", "Next actions"],
    plan: ["Objectives and constraints", "Options", "Decisions", "Delivery steps", "Validation", "Next actions"],
    draft: ["Audience and purpose", "Draft", "Unresolved claims"]
  }[kind];
  return `${kind === "draft" ? "<!-- topical:tasks off -->\n\n" : ""}# ${title}\n\nStatus: working\n\n${brief ? brief + "\n\n" : ""}${sections.map((heading) => `## ${heading}\n`).join("\n")}`;
}

export function workPath(kind, slug) {
  if (!WORK_TYPES.includes(kind) || typeof slug !== "string" || slug.length > 100 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new TopicalError("Use a work type and a lowercase hyphenated slug of at most 100 characters.");
  return kind === "draft" ? `drafts/${slug}.md` : `${kind === "issue" ? "issues" : "plans"}/${slug}/context.md`;
}

export function linkWork(markdown, link) {
  const children = fromMarkdown(markdown).children;
  const index = children.findIndex((node) => node.type === "heading" && node.depth === 2 && node.children.map((child) => child.value || "").join("") === "Active work");
  if (index < 0) return `${markdown.trimEnd()}\n\n## Active work\n\n${link}\n`;
  const next = children.slice(index + 1).find((node) => node.type === "heading" && node.depth <= 2);
  const end = next ? next.position.start.offset : markdown.length;
  return `${markdown.slice(0, end).trimEnd()}\n${link}\n\n${markdown.slice(end)}`;
}
