#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";

import { formatNodeVersionError, supportsNode } from "./startup.js";

export function runRuntimePreflight({ version = process.version, stderr = process.stderr } = {}) {
  if (supportsNode(version)) return true;

  stderr.write(`${formatNodeVersionError(version)}\n`);
  return false;
}

const isEntrypoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint && !runRuntimePreflight()) {
  process.exitCode = 1;
}
