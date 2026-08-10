#!/usr/bin/env node

import process from "node:process";

import { formatNodeVersionError, formatStartupError, supportsNode } from "./startup.js";

function help() {
  return [
    "Usage: topical-mcp [--doctor [--json]]",
    "",
    "Without arguments, starts the Topical MCP server over stdio.",
    "--doctor performs read-only startup, dependency, path, and cache checks."
  ].join("\n");
}

async function run() {
  if (!supportsNode(process.version)) {
    process.stderr.write(`${formatNodeVersionError(process.version)}\n`);
    process.exitCode = 1;
    return;
  }

  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${help()}\n`);
    return;
  }

  const doctor = args.includes("--doctor");
  const json = args.includes("--json");
  const unknown = args.filter((argument) => !["--doctor", "--json"].includes(argument));
  if (unknown.length || (json && !doctor)) {
    process.stderr.write(`Topical MCP cannot start: unsupported arguments: ${args.join(" ")}\n${help()}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    if (doctor) {
      const { formatDoctorReport, runDoctor } = await import("./doctor.js");
      const report = await runDoctor({ cwd: process.cwd(), env: process.env });
      process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${formatDoctorReport(report)}\n`);
      if (!report.ok) process.exitCode = 1;
      return;
    }

    const { startServer } = await import("./mcp-server.js");
    await startServer();
  } catch (error) {
    process.stderr.write(`${formatStartupError(error)}\n`);
    process.exitCode = 1;
  }
}

run();
