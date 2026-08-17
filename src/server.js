#!/usr/bin/env node

import process from "node:process";

import { formatNodeVersionError, formatStartupError, supportsNode } from "./startup.js";

function help() {
  return [
    "Usage: topical [mcp|ui|doctor] [options]",
    "",
    "Without a command, starts the Topical MCP server over stdio.",
    "doctor [--json] performs read-only startup, dependency, path, and cache checks.",
    "ui [--port <number>] [--no-open] starts the loopback-only management UI."
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

  const explicitCommand = args[0] && !args[0].startsWith("-");
  const command = explicitCommand ? args[0] : "mcp";
  const commandArgs = explicitCommand ? args.slice(1) : args;
  const doctor = command === "doctor" || commandArgs.includes("--doctor");
  const json = args.includes("--json");
  const validCommand = ["mcp", "ui", "doctor"].includes(command);
  const allowed = command === "ui" ? ["--no-open", "--port"] : ["--doctor", "--json"];
  const unknown = commandArgs.filter((argument, index) => !allowed.includes(argument) && commandArgs[index - 1] !== "--port");
  if (!validCommand || unknown.length || (json && !doctor)) {
    process.stderr.write(`Topical cannot start: unsupported arguments: ${args.join(" ")}\n${help()}\n`);
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

    if (command === "ui") {
      const portIndex = commandArgs.indexOf("--port");
      const port = portIndex === -1 ? 0 : Number(commandArgs[portIndex + 1]);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be an integer from 0 to 65535.");
      const { TopicalApplication } = await import("./application.js");
      const { loadTopicalConfig } = await import("./config.js");
      const { createHttpServer } = await import("./http-server.js");
      const application = new TopicalApplication(await loadTopicalConfig());
      await application.initialize();
      let server;
      try {
        ({ server } = createHttpServer({ application }));
        await server.listen({ host: "127.0.0.1", port });
        const address = server.listeningOrigin;
        process.stdout.write(`Topical UI: ${address}\n`);
        if (!commandArgs.includes("--no-open")) {
          const { default: open } = await import("open");
          await open(address);
        }
      } catch (error) {
        if (server) await server.close();
        await application.close();
        throw error;
      }
      let closing = false;
      const close = async () => {
        if (closing) return;
        closing = true;
        await server.close();
        await application.close();
      };
      process.once("SIGINT", () => close().finally(() => process.exit(0)));
      process.once("SIGTERM", () => close().finally(() => process.exit(0)));
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
