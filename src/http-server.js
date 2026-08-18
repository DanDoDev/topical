import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { z, ZodError } from "zod";

import { TopicalError } from "./errors.js";

const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const description = z.string().trim().min(3).max(500);
const topic = z.string().min(1).max(200);
const filePath = z.string().min(1).max(2000);
const cursor = z.string().min(1).optional();
const uuid = z.string().uuid();
const tags = z.array(z.string().min(1)).max(50).default([]);
const limit = (maximum = 100, fallback = 50) => z.preprocess(
  (value) => value === undefined ? fallback : Number(value),
  z.number().int().min(1).max(maximum)
);

const readQuery = z.object({ topic, path: filePath.default("context.md") });
const topicListQuery = z.object({
  sort: z.enum(["recent", "title", "created"]).default("recent"),
  tags: z.preprocess(queryTags, tags),
  cursor,
  limit: limit()
});
const searchQuery = z.object({
  q: z.string().max(2000).default(""),
  tags: z.preprocess(queryTags, tags),
  limit: limit(50, 10)
});
const pagedQuery = z.object({ cursor, limit: limit() });

function queryTags(value) {
  if (value === undefined || value === "") return [];
  if (Array.isArray(value)) return value.flatMap((item) => String(item).split(",")).filter(Boolean);
  return String(value).split(",").filter(Boolean);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function statusFor(error) {
  if (error instanceof ZodError) return 400;
  if (!(error instanceof TopicalError)) return 500;
  if (error.code === "CONFLICT") return 409;
  if (error.code === "INVALID_CURSOR") return 400;
  if (/does not exist|not indexed|not found/i.test(error.message)) return 404;
  return 400;
}

function errorBody(error) {
  if (error instanceof ZodError) {
    return { error: { code: "VALIDATION_ERROR", message: "Request validation failed.", details: error.flatten() } };
  }
  if (error instanceof TopicalError) {
    return { error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } };
  }
  return { error: { code: "INTERNAL_ERROR", message: "Unexpected Topical error." } };
}

function endpoint(schema, select, handler) {
  return async (request) => handler(schema ? schema.parse(select(request)) : undefined, request);
}

export function createHttpServer({ application, csrfToken = randomBytes(32).toString("base64url"), serveUi = true } = {}) {
  if (!application) throw new Error("application is required.");
  const server = Fastify({ logger: false, bodyLimit: MAX_MARKDOWN_BYTES + 64 * 1024 });

  server.addHook("onRequest", async (request, reply) => {
    const host = request.headers.host || "";
    if (!/^127\.0\.0\.1(?::\d+)?$/.test(host)) {
      return reply.code(403).send({ error: { code: "LOCAL_ONLY", message: "Topical UI accepts only its loopback origin." } });
    }

    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Cross-Origin-Opener-Policy", "same-origin");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    reply.header("Content-Security-Policy", "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'");
    if (request.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");

    if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method) || !request.url.startsWith("/api/")) return;
    const origin = request.headers.origin;
    const fetchSite = request.headers["sec-fetch-site"];
    if (origin !== `http://${host}` || (fetchSite && fetchSite !== "same-origin")) {
      return reply.code(403).send({ error: { code: "ORIGIN_REJECTED", message: "State-changing requests must come from the Topical UI origin." } });
    }
    if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
      return reply.code(415).send({ error: { code: "CONTENT_TYPE_REQUIRED", message: "State-changing requests require application/json." } });
    }
    if (!safeEqual(request.headers["x-topical-csrf"], csrfToken)) {
      return reply.code(403).send({ error: { code: "CSRF_REJECTED", message: "The Topical UI session token is missing or invalid." } });
    }
  });

  server.setErrorHandler((error, _request, reply) => reply.code(statusFor(error)).send(errorBody(error)));

  server.get("/api/v1/bootstrap", async () => ({
    version: "0.5.0-dev",
    csrfToken,
    ...(await application.getRevision()),
    capabilities: ["topics", "search", "editing", "taxonomy", "history", "trash", "publications", "health", "reindex", "live-refresh", "catalogue-inspection"]
  }));
  server.get("/api/v1/revision", async () => application.getRevision());
  server.get("/api/v1/topics", endpoint(topicListQuery, (request) => request.query, (input) => application.listTopics(input)));
  server.get("/api/v1/topics/:topic/overview", endpoint(z.object({ topic }), (request) => request.params, (input) => application.getTopicOverview(input)));
  server.get("/api/v1/topic-file", endpoint(readQuery, (request) => request.query, ({ topic, path }) => application.readTopicFile({ topic, filePath: path })));
  server.get("/api/v1/catalogues/root", endpoint(z.object({ view: z.enum(["rendered", "raw"]).default("rendered") }), (request) => request.query, (input) => application.readRootCatalogue(input)));
  server.get("/api/v1/catalogues/topic", endpoint(z.object({ topic, view: z.enum(["rendered", "raw"]).default("rendered") }), (request) => request.query, (input) => application.readTopicCatalogue(input)));
  server.get("/api/v1/search", endpoint(searchQuery, (request) => request.query, ({ q, ...input }) => application.searchTopics({ ...input, query: q })));
  server.get("/api/v1/tags", endpoint(pagedQuery.extend({ query: z.string().max(2000).default("") }), (request) => request.query, (input) => application.listTags(input)));
  server.get("/api/v1/history", endpoint(pagedQuery.extend({ topic: topic.optional() }), (request) => request.query, (input) => application.listHistory(input)));
  server.get("/api/v1/trash", endpoint(pagedQuery.extend({ type: z.enum(["file", "topic"]).optional(), topic: topic.optional() }), (request) => request.query, (input) => application.listTrash(input)));
  server.get("/api/v1/health", async () => application.getSystemHealth());
  server.get("/api/v1/publications", endpoint(pagedQuery.extend({ topic: topic.optional(), includeArchived: z.preprocess((value) => value === "true", z.boolean()).default(false) }), (request) => request.query, (input) => application.listPublications(input)));
  server.get("/api/v1/publications/:id", endpoint(z.object({ id: uuid }), (request) => request.params, (input) => application.readPublication(input)));

  server.post("/api/v1/topics", endpoint(z.object({ title: z.string().trim().min(1).max(160), summary: z.string().max(500).default(""), tags, initialContent: z.string().max(MAX_MARKDOWN_BYTES).default(""), description }), (request) => request.body, (input) => application.createTopic(input)));
  server.post("/api/v1/topic-files", endpoint(z.object({ topic, filePath, content: z.string().max(MAX_MARKDOWN_BYTES).default(""), description }), (request) => request.body, (input) => application.createTopicFile(input)));
  server.patch("/api/v1/topic-file", endpoint(z.object({ topic, filePath: filePath.default("context.md"), mode: z.enum(["append", "replace", "replace_section"]).default("replace"), content: z.string().max(MAX_MARKDOWN_BYTES), section: z.string().optional(), expectedHash: hash, description }), (request) => request.body, (input) => application.updateTopicFile(input)));
  server.patch("/api/v1/topic-metadata", endpoint(z.object({ topic, title: z.string().trim().min(1).max(160).optional(), summary: z.string().max(500).optional(), tags: tags.optional(), expectedHash: hash, description }), (request) => request.body, (input) => application.updateTopicMetadata(input)));
  server.delete("/api/v1/topic-file", endpoint(z.object({ topic, filePath, expectedHash: hash, description }), (request) => request.body, (input) => application.deleteTopicFile({ ...input, confirm: true })));
  server.delete("/api/v1/topic", endpoint(z.object({ topic, expectedHash: hash, description }), (request) => request.body, (input) => application.deleteTopic({ ...input, confirm: true })));
  server.post("/api/v1/trash/:id/restore", endpoint(z.object({ params: z.object({ id: uuid }), body: z.object({ expectedHash: hash, description }) }), (request) => ({ params: request.params, body: request.body }), ({ params, body }) => application.restoreTrash({ id: params.id, ...body })));
  server.post("/api/v1/reindex", endpoint(z.object({ description }), (request) => request.body, () => application.reindex()));
  server.post("/api/v1/publications", endpoint(z.object({ topic, sourceFiles: z.array(filePath).min(1).max(100).default(["context.md"]), destinationAlias: z.string().min(1), destinationPath: filePath, content: z.string().max(MAX_MARKDOWN_BYTES), label: z.string().max(160).optional(), description }), (request) => request.body, (input) => application.publishDocument(input)));
  server.put("/api/v1/publications/:id", endpoint(z.object({ params: z.object({ id: uuid }), body: z.object({ content: z.string().max(MAX_MARKDOWN_BYTES), expectedTargetHash: hash, sourceFiles: z.array(filePath).min(1).max(100).optional(), description }) }), (request) => ({ params: request.params, body: request.body }), ({ params, body }) => application.updatePublication({ id: params.id, ...body })));
  server.delete("/api/v1/publications/:id", endpoint(z.object({ params: z.object({ id: uuid }), body: z.object({ description }) }), (request) => ({ params: request.params, body: request.body }), ({ params, body }) => application.forgetPublication({ id: params.id, ...body, confirm: true })));

  if (serveUi) {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../ui-dist");
    server.register(fastifyStatic, { root });
    server.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "API route not found." } });
      if (request.url.startsWith("/assets/")) return reply.code(404).type("text/plain").send("UI asset not found. Reload Topical to use the current build.");
      return reply.sendFile("index.html");
    });
  }

  return { server, csrfToken };
}
