export const RELEVANCE_FIXTURE_ID = "relevance-v4";

export const RELEVANCE_DOCUMENTS = Object.freeze([
  {
    topic: "orchard-operations",
    title: "Orchard service operations",
    summary: "Cleanup, backup, recovery, and continuity procedures for a fictional deployment.",
    tags: [],
    path: "context.md",
    headings: ["Backup and recovery"],
    body: "Keep verified backups before cleanup. Test recovery steps and record restore evidence."
  },
  {
    topic: "orchard-operations",
    title: "Orchard service operations",
    summary: "Cleanup, backup, recovery, and continuity procedures for a fictional deployment.",
    tags: [],
    path: "cleanup-procedure.md",
    headings: ["Safe cleanup"],
    body: "The cleanup sequence preserves recovery options and validates each service before proceeding."
  },
  {
    topic: "utility-library",
    title: "Utility library",
    summary: "Maintenance utilities, cleanup procedures, and recovery notes.",
    tags: [],
    path: "context.md",
    headings: ["Cleanup and recovery"],
    body: "Consolidate cleanup utilities while retaining a documented recovery path."
  },
  {
    topic: "atlas-retrieval",
    title: "Atlas retrieval architecture",
    summary: "Search architecture, indexing decisions, publication behavior, and interface notes for a fictional knowledge system.",
    tags: [],
    path: "context.md",
    headings: ["Retrieval architecture"],
    body: "The retrieval guide keeps Markdown authoritative and schedules indexing before interface work."
  },
  {
    topic: "atlas-retrieval",
    title: "Atlas retrieval architecture",
    summary: "Search architecture, indexing decisions, publication behavior, and interface notes for a fictional knowledge system.",
    tags: [],
    path: "publication-design.md",
    headings: ["Publication architecture"],
    body: "Publication architecture keeps destination documents independent from central source material."
  },
  {
    topic: "guide-de-continuite-des-services",
    title: "Guide de continuité des services",
    summary: "Guide francophone fictif pour la gouvernance, la continuité et la récupération des services.",
    tags: [],
    path: "context.md",
    headings: ["Continuité et récupération"],
    body: "Le processus prévoit une approbation explicite, un plan de continuité et des étapes de récupération vérifiables."
  },
  {
    topic: "identifier-contracts",
    title: "Identifier contract reference",
    summary: "Fictional interface naming examples.",
    tags: ["api-contract"],
    path: "context.md",
    headings: ["Technical identifiers"],
    body: "The interface exposes expectedHash on Node.js and documents snake_case, kebab-case, service.v2, and /var/lib/atlas paths."
  },
  {
    topic: "cohesive-evidence",
    title: "Cohesive evidence",
    summary: "A colocated phrase fixture.",
    tags: [],
    path: "context.md",
    headings: ["Colocated evidence"],
    body: "The amber falcon marker appears as one exact phrase in this file."
  },
  {
    topic: "distributed-evidence",
    title: "Distributed evidence",
    summary: "A split-term fixture.",
    tags: [],
    path: "context.md",
    headings: ["Amber evidence"],
    body: "This file contains the amber marker only."
  },
  {
    topic: "distributed-evidence",
    title: "Distributed evidence",
    summary: "A split-term fixture.",
    tags: [],
    path: "falcon.md",
    headings: ["Falcon evidence"],
    body: "This separate file contains the falcon marker only."
  },
  {
    topic: "script-reference",
    title: "脚本检索参考",
    summary: "虚构的字符检索样本。",
    tags: [],
    path: "context.md",
    headings: ["完整标记"],
    body: "流程 备份恢复 验证。"
  },
  {
    topic: "morphology-reference",
    title: "Référence morphologique",
    summary: "Échantillon fictif sans racinisation linguistique.",
    tags: [],
    path: "context.md",
    headings: ["Formes exactes"],
    body: "Les projets et validations restent des formes lexicales exactes. L’équipe d’exploitation vérifie les résultats."
  },
  {
    topic: "solar-archive-blueprint",
    title: "Solar Archive Blueprint",
    summary: "Exact-title ranking fixture.",
    tags: [],
    path: "context.md",
    headings: ["Design"],
    body: "A concise fictional design record."
  },
  {
    topic: "solar-notes",
    title: "Solar notes",
    summary: "Body-only title distractor.",
    tags: [],
    path: "context.md",
    headings: ["Notes"],
    body: "The phrase solar archive blueprint appears only in ordinary body prose."
  },
  {
    topic: "long-query-reference",
    title: "Long query reference",
    summary: "Characterizes the current meaningful-term cap.",
    tags: [],
    path: "context.md",
    headings: ["Twenty retained markers"],
    body: "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango"
  }
]);

export const STRICT_RELEVANCE_CASES = Object.freeze([
  { query: "backup recovery", first: "orchard-operations", topics: ["orchard-operations"] },
  { query: "retrieval architecture", first: "atlas-retrieval", topics: ["atlas-retrieval"] },
  { query: "cleanup recovery", first: "orchard-operations", topics: ["orchard-operations", "utility-library"] },
  { query: "publication architecture", first: "atlas-retrieval", topics: ["atlas-retrieval"] },
  { query: "recuperation continuite", first: "guide-de-continuite-des-services", topics: ["guide-de-continuite-des-services"] },
  { query: "processus approbation", first: "guide-de-continuite-des-services", topics: ["guide-de-continuite-des-services"] }
]);

export const RELAXED_RELEVANCE_CASE = Object.freeze({
  query: "publication recovery",
  topics: ["atlas-retrieval", "orchard-operations", "utility-library"]
});

const LONG_QUERY = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango omitted";

export const RELEVANCE_EVALUATION_CASES = Object.freeze([
  ...STRICT_RELEVANCE_CASES.map((entry, index) => ({
    id: `baseline-strict-${index + 1}`,
    query: entry.query,
    expectedMode: "strict",
    expectedFirst: entry.first,
    allowedTopics: entry.topics,
    forbiddenTopics: []
  })),
  {
    id: "baseline-relaxed",
    query: RELAXED_RELEVANCE_CASE.query,
    expectedMode: "relaxed",
    expectedFirst: "atlas-retrieval",
    allowedTopics: RELAXED_RELEVANCE_CASE.topics,
    forbiddenTopics: []
  },
  {
    id: "exact-title-versus-body",
    query: "Solar Archive Blueprint",
    expectedMode: "strict",
    expectedFirst: "solar-archive-blueprint",
    allowedTopics: ["solar-archive-blueprint", "solar-notes"],
    forbiddenTopics: [],
    expectedFirstFields: ["title"]
  },
  {
    id: "technical-identifier-exact",
    query: "expectedHash",
    expectedMode: "strict",
    expectedFirst: "identifier-contracts",
    allowedTopics: ["identifier-contracts"],
    forbiddenTopics: []
  },
  {
    id: "technical-identifier-separated-alias",
    query: "expected hash",
    expectedMode: "strict",
    expectedFirst: "identifier-contracts",
    allowedTopics: ["identifier-contracts"],
    forbiddenTopics: [],
    expectedFirstFields: ["aliases"]
  },
  {
    id: "joined-technical-identifier-alias",
    query: "nodejs",
    expectedMode: "strict",
    expectedFirst: "identifier-contracts",
    allowedTopics: ["identifier-contracts"],
    forbiddenTopics: [],
    expectedFirstFields: ["aliases"]
  },
  {
    id: "separator-neutral-identifier",
    query: "snake case",
    expectedMode: "strict",
    expectedFirst: "identifier-contracts",
    allowedTopics: ["identifier-contracts"],
    forbiddenTopics: []
  },
  {
    id: "same-file-cohesion",
    query: "amber falcon",
    expectedMode: "strict",
    expectedFirst: "cohesive-evidence",
    allowedTopics: ["cohesive-evidence", "distributed-evidence"],
    forbiddenTopics: []
  },
  {
    id: "complete-cjk-token",
    query: "备份恢复",
    expectedMode: "strict",
    expectedFirst: "script-reference",
    allowedTopics: ["script-reference"],
    forbiddenTopics: []
  },
  {
    id: "cjk-substring-miss",
    query: "备份",
    expectedMode: "relaxed",
    expectedFirst: null,
    allowedTopics: [],
    forbiddenTopics: ["script-reference"]
  },
  {
    id: "exact-french-morphology",
    query: "projets validations",
    expectedMode: "strict",
    expectedFirst: "morphology-reference",
    allowedTopics: ["morphology-reference"],
    forbiddenTopics: []
  },
  {
    id: "conservative-french-edit-expansion",
    query: "projet validation",
    expectedMode: "expanded",
    expectedFirst: "morphology-reference",
    allowedTopics: ["morphology-reference"],
    forbiddenTopics: []
  },
  {
    id: "accent-and-apostrophe-neutral",
    query: "equipe exploitation",
    expectedMode: "strict",
    expectedFirst: "morphology-reference",
    allowedTopics: ["morphology-reference"],
    forbiddenTopics: []
  },
  {
    id: "current-twenty-term-cap",
    query: LONG_QUERY,
    expectedMode: "strict",
    expectedFirst: "long-query-reference",
    allowedTopics: ["long-query-reference"],
    forbiddenTopics: []
  },
  {
    id: "negative-distractor",
    query: "xylophonic zeppelin",
    expectedMode: "relaxed",
    expectedFirst: null,
    allowedTopics: [],
    forbiddenTopics: RELEVANCE_DOCUMENTS.map((document) => document.topic)
  }
]);
