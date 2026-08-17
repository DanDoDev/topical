import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ApiError, connectApi, queryString } from "./api.js";

function queuedFetch(...responses: Response[]) {
  const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push([input, init]);
    const response = responses.shift();
    assert.ok(response, "Unexpected fetch call.");
    return response;
  };
  return { calls, fetcher: fetcher as typeof fetch };
}

describe("local API client", () => {
  it("keeps the per-run token out of reads and sends it on JSON mutations", async () => {
    const { calls, fetcher } = queuedFetch(
      new Response(JSON.stringify({ csrfToken: "secret", version: "test" }), { status: 200, headers: { "Content-Type": "application/json" } }),
      new Response(JSON.stringify({ topics: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
      new Response(JSON.stringify({ topic: "demo" }), { status: 200, headers: { "Content-Type": "application/json" } })
    );
    const { api } = await connectApi(fetcher as typeof fetch);

    await api.get("/topics");
    await api.send("POST", "/topics", { title: "Demo" });

    assert.equal((calls[1][1]?.headers as Record<string, string> | undefined)?.["X-Topical-CSRF"], undefined);
    const mutationHeaders = calls[2][1]?.headers as Record<string, string>;
    assert.equal(mutationHeaders["Content-Type"], "application/json");
    assert.equal(mutationHeaders["X-Topical-CSRF"], "secret");
    assert.doesNotMatch(String(calls[2][0]), /secret/);
  });

  it("returns structured API failures", async () => {
    const { fetcher } = queuedFetch(
      new Response(JSON.stringify({ csrfToken: "secret" }), { status: 200 }),
      new Response(JSON.stringify({ error: { code: "CONFLICT", message: "Changed", details: { currentHash: "abc" } } }), { status: 409 })
    );
    const { api } = await connectApi(fetcher as typeof fetch);
    await assert.rejects(api.send("PATCH", "/topic-file", {}), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, "CONFLICT");
      assert.equal(error.status, 409);
      assert.deepEqual(error.details, { currentHash: "abc" });
      return true;
    });
  });

  it("encodes repeated filters without embedding paths into route segments", () => {
    assert.equal(queryString({ topic: "project topical", path: "research/one.md", tags: ["one", "two"] }), "?topic=project+topical&path=research%2Fone.md&tags=one&tags=two");
  });
});
