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
