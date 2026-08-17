import { TopicalError } from "./errors.js";

function decodeCursor(cursor) {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (parsed?.version !== 1 || !Number.isInteger(parsed.offset) || parsed.offset < 0) throw new Error();
    return parsed.offset;
  } catch {
    throw new TopicalError("cursor is invalid or incompatible.", { code: "INVALID_CURSOR" });
  }
}

function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ version: 1, offset }), "utf8").toString("base64url");
}

export function paginate(items, { cursor, limit = 50, maxLimit = 100 } = {}) {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 50, maxLimit));
  const offset = decodeCursor(cursor);
  const pageItems = items.slice(offset, offset + boundedLimit);
  const nextOffset = offset + pageItems.length;
  return {
    items: pageItems,
    page: {
      limit: boundedLimit,
      total: items.length,
      nextCursor: nextOffset < items.length ? encodeCursor(nextOffset) : null
    }
  };
}
