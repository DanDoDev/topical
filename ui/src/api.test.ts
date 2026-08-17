import { describe, expect, it, vi } from "vitest";

import { ApiError, connectApi, queryString } from "./api";

describe("local API client", () => {
  it("keeps the per-run token out of reads and sends it on JSON mutations", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: "secret", version: "test" }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ topics: [] }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ topic: "demo" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const { api } = await connectApi(fetcher as typeof fetch);

    await api.get("/topics");
    await api.send("POST", "/topics", { title: "Demo" });

    expect(fetcher.mock.calls[1][1].headers).not.toHaveProperty("X-Topical-CSRF");
    expect(fetcher.mock.calls[2][1].headers).toMatchObject({ "Content-Type": "application/json", "X-Topical-CSRF": "secret" });
    expect(fetcher.mock.calls[2][0]).not.toContain("secret");
  });

  it("returns structured API failures", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: "secret" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "CONFLICT", message: "Changed", details: { currentHash: "abc" } } }), { status: 409 }));
    const { api } = await connectApi(fetcher as typeof fetch);
    await expect(api.send("PATCH", "/topic-file", {})).rejects.toMatchObject({ code: "CONFLICT", status: 409, details: { currentHash: "abc" } } satisfies Partial<ApiError>);
  });

  it("encodes repeated filters without embedding paths into route segments", () => {
    expect(queryString({ topic: "project topical", path: "research/one.md", tags: ["one", "two"] })).toBe("?topic=project+topical&path=research%2Fone.md&tags=one&tags=two");
  });
});
