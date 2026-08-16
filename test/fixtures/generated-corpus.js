import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const BENCHMARK_DOCUMENT_COUNTS = Object.freeze([100, 1_000, 10_000]);
export const BENCHMARK_FIXTURE_ID = "generated-corpus-v1";

function contextMarkdown(topicNumber) {
  const french = topicNumber % 5 === 0;
  const title = french ? `Guide de continuité ${topicNumber}` : `Operations topic ${topicNumber}`;
  const summary = french
    ? "Processus de récupération, approbation et continuité des services."
    : "Backup recovery, cleanup, publication, and runbook reference set.";
  return `---\ntitle: ${JSON.stringify(title)}\nsummary: ${JSON.stringify(summary)}\ntags: []\ncreated_at: 2026-08-08T00:00:00.000Z\nupdated_at: 2026-08-08T00:00:00.000Z\n---\n\n# ${title}\n\n${summary}\n`;
}

function supportingMarkdown(topicNumber, fileNumber) {
  if ((topicNumber + fileNumber) % 7 === 0) {
    return `# Continuité ${fileNumber}\n\nLe processus de récupération exige une approbation explicite et des preuves vérifiables. Document ${topicNumber}-${fileNumber}.\n`;
  }
  return `# Recovery procedure ${fileNumber}\n\nBackup recovery and cleanup steps preserve publication independence and runbook records. Document ${topicNumber}-${fileNumber}.\n`;
}

export function generateBenchmarkFixture(documentCount) {
  if (!BENCHMARK_DOCUMENT_COUNTS.includes(documentCount)) {
    throw new RangeError(`documentCount must be one of ${BENCHMARK_DOCUMENT_COUNTS.join(", ")}.`);
  }
  const topicCount = Math.ceil(documentCount / 100);
  let remaining = documentCount;
  const topics = [];
  for (let topicNumber = 1; topicNumber <= topicCount; topicNumber += 1) {
    const filesInTopic = Math.min(100, remaining);
    const id = `benchmark-topic-${String(topicNumber).padStart(3, "0")}`;
    const files = [{ path: "context.md", content: contextMarkdown(topicNumber) }];
    for (let fileNumber = 1; fileNumber < filesInTopic; fileNumber += 1) {
      files.push({
        path: `notes/document-${String(fileNumber).padStart(3, "0")}.md`,
        content: supportingMarkdown(topicNumber, fileNumber)
      });
    }
    topics.push({ id, files });
    remaining -= filesInTopic;
  }
  return { documentCount, topicCount, topics };
}

export async function materializeBenchmarkFixture(root, fixture) {
  const writes = [];
  for (const topic of fixture.topics) {
    for (const file of topic.files) {
      const target = path.join(root, topic.id, file.path);
      writes.push((async () => {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.content, "utf8");
      })());
      if (writes.length >= 200) await Promise.all(writes.splice(0));
    }
  }
  await Promise.all(writes);
  return fixture;
}
