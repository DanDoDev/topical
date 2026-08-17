import { readFile } from "node:fs/promises";
import path from "node:path";

export async function loadEnvironment({ cwd = process.cwd(), env = process.env } = {}) {
  const values = { ...env };
  try {
    const text = await readFile(path.resolve(cwd, ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || values[match[1]] !== undefined) continue;
      values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch { /* A .env file is optional. */ }
  return values;
}

export function parsePublicationRoots(value = "") {
  const roots = {};
  for (const item of value.split(";").map((entry) => entry.trim()).filter(Boolean)) {
    const separator = item.indexOf("=");
    if (separator < 1) throw new Error("TOPICAL_PUBLISH_ROOTS entries must use alias=absolute-path.");
    roots[item.slice(0, separator).trim()] = item.slice(separator + 1).trim();
  }
  return roots;
}

export async function loadTopicalConfig(options = {}) {
  const env = await loadEnvironment(options);
  const root = env.TOPICAL_ROOT;
  if (!root) throw new Error("TOPICAL_ROOT is required. Set it in MCP configuration or a local .env file.");
  return {
    root,
    publicationRoots: parsePublicationRoots(env.TOPICAL_PUBLISH_ROOTS)
  };
}
