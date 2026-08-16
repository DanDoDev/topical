function rounded(value) {
  return Number(value.toFixed(4));
}

export async function evaluateRelevance(search, cases) {
  const outcomes = [];

  for (const relevanceCase of cases) {
    const result = await search(relevanceCase.query);
    const returnedTopics = result.topics.map((topic) => topic.topic);
    const relevant = new Set(relevanceCase.allowedTopics);
    const expectedRank = relevanceCase.expectedFirst
      ? returnedTopics.indexOf(relevanceCase.expectedFirst) + 1
      : 0;
    const topThreeRelevant = returnedTopics.slice(0, 3).filter((topic) => relevant.has(topic)).length;
    const falsePositives = returnedTopics.filter((topic) => !relevant.has(topic));

    outcomes.push({
      id: relevanceCase.id,
      query: relevanceCase.query,
      expectedMode: relevanceCase.expectedMode,
      actualMode: result.matchMode,
      expectedFirst: relevanceCase.expectedFirst,
      actualFirst: returnedTopics[0] || null,
      expectedRank,
      allowedTopics: [...relevant],
      returnedTopics,
      forbiddenReturned: returnedTopics.filter((topic) => relevanceCase.forbiddenTopics.includes(topic)),
      recallAt3: relevant.size ? topThreeRelevant / relevant.size : (returnedTopics.length ? 0 : 1),
      falsePositives,
      firstFields: result.topics[0]?.matchedFields || []
    });
  }

  const positive = outcomes.filter((outcome) => outcome.expectedFirst);
  const negative = outcomes.filter((outcome) => !outcome.expectedFirst);
  const returnedCount = outcomes.reduce((sum, outcome) => sum + outcome.returnedTopics.length, 0);
  const falsePositiveCount = outcomes.reduce((sum, outcome) => sum + outcome.falsePositives.length, 0);
  return {
    outcomes,
    metrics: {
      cases: outcomes.length,
      positiveCases: positive.length,
      negativeCases: negative.length,
      firstResultAccuracy: rounded(positive.filter((outcome) => outcome.actualFirst === outcome.expectedFirst).length / positive.length),
      negativeAccuracy: rounded(negative.filter((outcome) => outcome.actualFirst === null).length / negative.length),
      meanReciprocalRank: rounded(positive.reduce((sum, outcome) => sum + (outcome.expectedRank ? 1 / outcome.expectedRank : 0), 0) / positive.length),
      recallAt3: rounded(positive.reduce((sum, outcome) => sum + outcome.recallAt3, 0) / positive.length),
      strictHitRate: rounded(outcomes.filter((outcome) => outcome.actualMode === "strict").length / outcomes.length),
      fallbackRate: rounded(outcomes.filter((outcome) => outcome.actualMode === "relaxed").length / outcomes.length),
      expandedHitRate: rounded(outcomes.filter((outcome) => outcome.actualMode === "expanded").length / outcomes.length),
      falsePositiveRate: rounded(returnedCount ? falsePositiveCount / returnedCount : 0)
    }
  };
}
