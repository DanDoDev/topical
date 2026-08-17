import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = await mkdtemp(path.join(repositoryRoot, ".topical-ui-tests-"));

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repositoryRoot, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(signal ? `Test subprocess stopped by ${signal}.` : `Test subprocess exited with code ${code}.`));
    });
  });
}

try {
  await run(process.execPath, [
    path.join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"),
    "-p", path.join(repositoryRoot, "ui", "tsconfig.test.json"),
    "--outDir", outputDirectory
  ]);
  await run(process.execPath, [
    "--import", path.join(repositoryRoot, "test", "support", "ui-test-setup.js"),
    "--test",
    path.join(outputDirectory, "api.test.js"),
    path.join(outputDirectory, "MarkdownView.test.js"),
    path.join(outputDirectory, "App.test.js")
  ]);
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}
