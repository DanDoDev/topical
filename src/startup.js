export const REQUIRED_NODE_MAJOR = 24;

export function nodeMajor(version = process.version) {
  const match = String(version).match(/^v?(\d+)/);
  return match ? Number(match[1]) : Number.NaN;
}

export function supportsNode(version = process.version) {
  return nodeMajor(version) === REQUIRED_NODE_MAJOR;
}

export function formatNodeVersionError(version = process.version) {
  return [
    `Topical MCP cannot start: Node.js 24.x is required; found ${version}.`,
    "Fix:",
    "  1. In the Topical checkout, run: nvm install && nvm use",
    "  2. Reinstall native dependencies under Node 24: npm ci",
    "  3. Configure the MCP command to the absolute path returned by: nvm which 24",
    "  4. Restart the MCP host and retry Topical discovery.",
    "Adding TOPICAL_ROOT as a workspace folder does not change the MCP runtime."
  ].join("\n");
}

export function formatStartupError(error) {
  const message = error instanceof Error ? error.message : String(error || "Unexpected startup error.");
  const code = error && typeof error === "object" ? error.code : undefined;
  const lines = [`Topical MCP failed to start: ${message}`];

  if (code === "ERR_DLOPEN_FAILED" || /NODE_MODULE_VERSION|native module|better_sqlite3/i.test(message)) {
    lines.push("Fix: activate Node 24, run `npm ci` in the Topical checkout, and restart the MCP host.");
  } else if (code === "ERR_MODULE_NOT_FOUND" || /Cannot find (module|package)/i.test(message)) {
    lines.push("Fix: activate Node 24 and run `npm ci` in the Topical checkout before restarting the MCP host.");
  } else if (/TOPICAL_ROOT is required/i.test(message)) {
    lines.push("Fix: set TOPICAL_ROOT in the MCP server environment to an absolute, dedicated topic directory.");
  } else if (/FTS5/i.test(message)) {
    lines.push("Fix: reinstall dependencies under Node 24 with `npm ci`; Topical requires the FTS5-enabled better-sqlite3 build.");
  } else if (code === "EADDRINUSE") {
    lines.push("Fix: stop the process using that port or start the UI with `topical ui --port <number>`.");
  }

  lines.push("Diagnostic: run the configured Topical command with `--doctor` (or `--doctor --json`).");
  return lines.join("\n");
}
