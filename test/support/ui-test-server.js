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
