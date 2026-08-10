import { constants as fsConstants } from "node:fs";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { REQUIRED_NODE_MAJOR, supportsNode } from "./startup.js";

async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function environmentForDoctor(cwd, source) {
  const env = { ...source };
  try {
    const text = await readFile(path.join(cwd, ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || env[match[1]] !== undefined) continue;
      env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return env;
}

function check(name, status, message, fix) {
  return { name, status, message, ...(fix ? { fix } : {}) };
}

async function inspectDependencies(checks) {
  try {
    await import("@modelcontextprotocol/sdk/server/mcp.js");
    checks.push(check("MCP SDK", "pass", "The MCP server dependency loads under this runtime."));
  } catch (error) {
    checks.push(check("MCP SDK", "fail", error.message, "Activate Node 24 and run `npm ci` in the Topical checkout."));
  }

  try {
    const { default: Database } = await import("better-sqlite3");
    const database = new Database(":memory:");
    try {
      const sqliteVersion = database.prepare("SELECT sqlite_version()").pluck().get();
      const fts5 = database.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5')").pluck().get() === 1;
      if (!fts5) {
        checks.push(check("SQLite FTS5", "fail", `SQLite ${sqliteVersion} loaded without FTS5.`, "Run `npm ci` under Node 24 to install Topical's supported better-sqlite3 build."));
        return null;
      }
      checks.push(check("SQLite FTS5", "pass", `better-sqlite3 loaded SQLite ${sqliteVersion} with FTS5.`));
      return Database;
    } finally {
      database.close();
    }
  } catch (error) {
    checks.push(check("SQLite FTS5", "fail", error.message, "Activate Node 24 and run `npm ci`; native modules must be installed under the runtime that launches Topical."));
    return null;
  }
}

async function inspectRoot(root, checks) {
  if (!root) {
    checks.push(check("TOPICAL_ROOT", "fail", "TOPICAL_ROOT is not configured.", "Set it in the MCP server environment to an absolute, dedicated topic directory."));
    return null;
  }
  if (!path.isAbsolute(root)) {
    checks.push(check("TOPICAL_ROOT", "fail", `TOPICAL_ROOT must be absolute; received '${root}'.`, "Use an absolute path in the MCP server environment."));
    return null;
  }
  const resolved = path.resolve(root);
  if (resolved === path.parse(resolved).root || resolved === os.homedir()) {
    checks.push(check("TOPICAL_ROOT", "fail", "TOPICAL_ROOT cannot be the filesystem root or home directory.", "Choose a dedicated directory for Topical Markdown topics."));
    return null;
  }
  if (!await pathExists(resolved)) {
    checks.push(check("TOPICAL_ROOT", "warning", `The configured directory does not exist yet: ${resolved}`, "Topical will create it on normal startup; confirm the parent location is intentional and writable."));
    return { path: resolved, exists: false };
  }
  const details = await lstat(resolved);
  if (details.isSymbolicLink()) {
    checks.push(check("TOPICAL_ROOT", "fail", "TOPICAL_ROOT cannot be a symbolic link.", "Configure the real dedicated directory instead."));
    return null;
  }
  if (!details.isDirectory()) {
    checks.push(check("TOPICAL_ROOT", "fail", "TOPICAL_ROOT exists but is not a directory.", "Configure a dedicated directory."));
    return null;
  }
  const canonical = await realpath(resolved);
  try {
    await access(canonical, fsConstants.R_OK | fsConstants.W_OK);
  } catch (error) {
    checks.push(check("TOPICAL_ROOT", "fail", `TOPICAL_ROOT is not readable and writable: ${error.message}`, "Grant the MCP process access or configure another dedicated directory."));
    return null;
  }
  checks.push(check("TOPICAL_ROOT", "pass", `Readable, writable, dedicated directory: ${canonical}`));
  return { path: canonical, exists: true };
}

async function inspectCache(root, Database, checks) {
  if (!root?.exists) {
    checks.push(check("Search cache", "warning", "Cache inspection is deferred until TOPICAL_ROOT exists."));
    return;
  }
  const directory = path.join(root.path, ".topical-cache");
  const databasePath = path.join(directory, "search.sqlite");
  if (!await pathExists(directory)) {
    checks.push(check("Search cache", "pass", "No cache exists; Topical will rebuild derived search state from Markdown."));
    return;
  }
  const directoryDetails = await lstat(directory);
  if (directoryDetails.isSymbolicLink() || !directoryDetails.isDirectory()) {
    checks.push(check("Search cache", "fail", "The cache path must be a real directory, not a symlink or file.", "Remove or relocate the unsafe cache path without modifying topic Markdown."));
    return;
  }
  if (!await pathExists(databasePath)) {
    checks.push(check("Search cache", "pass", "The cache database is absent and will be rebuilt from Markdown."));
    return;
  }
  const databaseDetails = await lstat(databasePath);
  if (databaseDetails.isSymbolicLink() || !databaseDetails.isFile()) {
    checks.push(check("Search cache", "fail", "The cache database must be a real file, not a symlink or directory.", "Remove or relocate the unsafe derived cache without modifying topic Markdown."));
    return;
  }
  if (!Database) {
    checks.push(check("Search cache", "warning", "Cache contents were not inspected because better-sqlite3 did not load."));
    return;
  }
  try {
    const database = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      const integrity = database.pragma("quick_check", { simple: true });
      const schemaVersion = database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").pluck().get();
      const size = (await stat(databasePath)).size;
      const status = integrity === "ok" ? "pass" : "warning";
      checks.push(check("Search cache", status, `Read-only check: integrity=${integrity}, schema=${schemaVersion}, bytes=${size}.`, status === "warning" ? "Normal startup will rebuild corrupt or incompatible derived state from Markdown." : undefined));
    } finally {
      database.close();
    }
  } catch (error) {
    checks.push(check("Search cache", "warning", `Read-only cache inspection failed: ${error.message}`, "Normal startup will rebuild corrupt or incompatible derived state from Markdown."));
  }
}

async function inspectPublicationRoots(value, checks) {
  const entries = String(value || "").split(";").map((entry) => entry.trim()).filter(Boolean);
  if (!entries.length) {
    checks.push(check("Publication roots", "pass", "No optional publication roots are configured."));
    return;
  }
  const invalid = [];
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator < 1 || !path.isAbsolute(entry.slice(separator + 1).trim())) invalid.push(entry);
  }
  if (invalid.length) {
    checks.push(check("Publication roots", "fail", `Invalid alias=absolute-path entries: ${invalid.join(", ")}`, "Use semicolon-separated alias=absolute-path entries."));
  } else {
    checks.push(check("Publication roots", "pass", `${entries.length} optional publication root${entries.length === 1 ? "" : "s"} use alias=absolute-path syntax.`));
  }
}

export async function runDoctor({ cwd = process.cwd(), env: sourceEnv = process.env } = {}) {
  const env = await environmentForDoctor(cwd, sourceEnv);
  const checks = [];
  checks.push(supportsNode(process.version)
    ? check("Node.js", "pass", `Running ${process.version}; Topical requires Node ${REQUIRED_NODE_MAJOR}.x.`)
    : check("Node.js", "fail", `Running ${process.version}; Topical requires Node ${REQUIRED_NODE_MAJOR}.x.`, "Configure the MCP command to the absolute executable returned by `nvm which 24`."));
  const Database = await inspectDependencies(checks);
  const root = await inspectRoot(env.TOPICAL_ROOT, checks);
  await inspectCache(root, Database, checks);
  await inspectPublicationRoots(env.TOPICAL_PUBLISH_ROOTS, checks);
  return {
    ok: checks.every((entry) => entry.status !== "fail"),
    runtime: process.version,
    cwd,
    checks
  };
}

export function formatDoctorReport(report) {
  const labels = { pass: "PASS", warning: "WARN", fail: "FAIL" };
  const lines = ["Topical doctor"];
  for (const entry of report.checks) {
    lines.push(`${labels[entry.status]} ${entry.name}: ${entry.message}`);
    if (entry.fix) lines.push(`  Fix: ${entry.fix}`);
  }
  lines.push(report.ok ? "Result: ready" : "Result: blocked; fix the FAIL checks and restart the MCP host.");
  return lines.join("\n");
}
