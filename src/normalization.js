import { TopicalError } from "./errors.js";

export const CONTRACT_LIMITS = Object.freeze({
  descriptionChars: 500,
  markdownBytes: 5 * 1024 * 1024,
  queryChars: 2_000,
  queryTerms: 20,
  summaryChars: 500,
  tagChars: 80,
  tags: 50,
  titleChars: 160
});

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

export function normalizeSearchText(value) {
  return String(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export function canonicalTagKey(value) {
  return String(value).normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export function comparisonTagKey(value) {
  return normalizeSearchText(canonicalTagKey(value)).replace(/[\s._-]+/gu, " ").trim();
}

export function assertBoundedText(value, { field, maxChars, allowEmpty = true }) {
  if (typeof value !== "string") {
    throw new TopicalError(`${field} must be a string.`, { code: "INVALID_INPUT", details: { field } });
  }
  if (!allowEmpty && !value.trim()) {
    throw new TopicalError(`${field} cannot be empty.`, { code: "INVALID_INPUT", details: { field } });
  }
  if (value.length > maxChars) {
    throw new TopicalError(`${field} cannot exceed ${maxChars} characters.`, {
      code: "LIMIT_EXCEEDED",
      details: { field, maxChars, actualChars: value.length }
    });
  }
  return value;
}

export function assertDescription(description) {
  assertBoundedText(description, { field: "description", maxChars: CONTRACT_LIMITS.descriptionChars, allowEmpty: false });
  if (description.trim().length < 3) {
    throw new TopicalError("A short, one-sentence description is required for every change.", {
      code: "INVALID_INPUT",
      details: { field: "description" }
    });
  }
  return description.trim();
}

export function assertMarkdown(content) {
  if (typeof content !== "string") {
    throw new TopicalError("content must be a string.", { code: "INVALID_INPUT", details: { field: "content" } });
  }
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > CONTRACT_LIMITS.markdownBytes) {
    throw new TopicalError("Markdown content cannot exceed 5 MiB per file.", {
      code: "LIMIT_EXCEEDED",
      details: { field: "content", maxBytes: CONTRACT_LIMITS.markdownBytes, actualBytes: bytes }
    });
  }
  return content;
}

export function cleanTags(tags = []) {
  if (!Array.isArray(tags)) {
    throw new TopicalError("tags must be an array.", { code: "INVALID_INPUT", details: { field: "tags" } });
  }
  if (tags.length > CONTRACT_LIMITS.tags) {
    throw new TopicalError(`tags cannot contain more than ${CONTRACT_LIMITS.tags} values.`, {
      code: "LIMIT_EXCEEDED",
      details: { field: "tags", maxItems: CONTRACT_LIMITS.tags, actualItems: tags.length }
    });
  }
  const seen = new Set();
  const cleaned = [];
  for (const value of tags) {
    if (typeof value !== "string") {
      throw new TopicalError("Every tag must be a string.", { code: "INVALID_INPUT", details: { field: "tags" } });
    }
    const display = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
    if (!display) continue;
    if (CONTROL_CHARACTERS.test(display)) {
      throw new TopicalError("Tags cannot contain control characters.", { code: "INVALID_INPUT", details: { field: "tags" } });
    }
    if (display.length > CONTRACT_LIMITS.tagChars) {
      throw new TopicalError(`Tags cannot exceed ${CONTRACT_LIMITS.tagChars} characters.`, {
        code: "LIMIT_EXCEEDED",
        details: { field: "tags", maxChars: CONTRACT_LIMITS.tagChars, actualChars: display.length }
      });
    }
    const key = canonicalTagKey(display);
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(display);
  }
  return cleaned;
}

export function parseTagArray(value) {
  if (Array.isArray(value)) return value.filter((tag) => typeof tag === "string");
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.filter((tag) => typeof tag === "string");
  } catch { /* Fall through for legacy hand-authored arrays. */ }
  return trimmed.slice(1, -1)
    .split(",")
    .map((tag) => tag.trim().replace(/^(['"])(.*)\1$/, "$2"))
    .filter(Boolean);
}

export function analyzeQuery(value) {
  const source = String(value ?? "").trim();
  if (source.length > CONTRACT_LIMITS.queryChars) {
    throw new TopicalError(`query cannot exceed ${CONTRACT_LIMITS.queryChars} characters.`, {
      code: "LIMIT_EXCEEDED",
      details: { field: "query", maxChars: CONTRACT_LIMITS.queryChars, actualChars: source.length }
    });
  }
  const tokens = source.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) || [];
  const seen = new Set();
  const terms = [];
  const ignoredTerms = [];
  for (const token of tokens) {
    const normalized = normalizeSearchText(token);
    if (!normalized) continue;
    if (seen.has(normalized)) {
      ignoredTerms.push({ term: token, normalized, reason: "duplicate" });
      continue;
    }
    seen.add(normalized);
    if (terms.length >= CONTRACT_LIMITS.queryTerms) {
      ignoredTerms.push({ term: token, normalized, reason: "term_limit" });
      continue;
    }
    terms.push({ source: token, normalized });
  }
  return {
    source,
    normalized: normalizeSearchText(source),
    terms,
    ignoredTerms,
    limits: { maxChars: CONTRACT_LIMITS.queryChars, maxTerms: CONTRACT_LIMITS.queryTerms }
  };
}

export function queryAnalysisResponse(analysis) {
  return {
    retainedTerms: analysis.terms.map((term) => term.normalized),
    ignoredTerms: analysis.ignoredTerms.map((term) => ({ ...term })),
    limits: { ...analysis.limits }
  };
}
