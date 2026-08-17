import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TopicalApplication } from "../../src/application.js";
import { createHttpServer } from "../../src/http-server.js";

const root = await mkdtemp(path.join(os.tmpdir(), "topical-e2e-"));
const application = new TopicalApplication({ root });
await application.initialize();
await application.createTopic({
  title: "Browser Fixture",
  summary: "English and French end-to-end coverage.",
  tags: ["ui", "retrieval"],
  initialContent: "# Safe reading\n\nConflict-safe editing and recherche multilingue.\n\n<script>window.__unsafe = true</script>",
  description: "Created the browser-test fixture."
});
const { server } = createHttpServer({ application });
server.post("/api/v1/test-external-topic", async () => {
  const external = new TopicalApplication({ root });
  await external.initialize();
  try {
    return await external.createTopic({
      title: "External Browser Topic",
      summary: "Created by another process while the browser remains open.",
      tags: ["live-refresh"],
      initialContent: "# Appeared live\n\nNo browser or server refresh was required.",
      description: "Created the cross-process browser fixture."
    });
  } finally { await external.close(); }
});
server.post("/api/v1/test-external-file", async () => {
  const external = new TopicalApplication({ root });
  await external.initialize();
  try {
    const current = await external.readTopicFile({ topic: "browser-fixture", filePath: "context.md" });
    return await external.updateTopicFile({
      topic: "browser-fixture",
      filePath: "context.md",
      mode: "replace",
      content: `${current.content}\n\nChanged outside the browser.`,
      expectedHash: current.hash,
      description: "Changed the file through another process."
    });
  } finally { await external.close(); }
});
await server.listen({ host: "127.0.0.1", port: 43111 });
process.stdout.write("Topical E2E server ready\n");

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await server.close();
  await application.close();
}
process.once("SIGINT", () => close().finally(() => process.exit(0)));
process.once("SIGTERM", () => close().finally(() => process.exit(0)));
