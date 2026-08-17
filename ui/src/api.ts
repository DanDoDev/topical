export type ApiErrorPayload = {
  code: string;
  message: string;
  details?: unknown;
};

export class ApiError extends Error {
  code: string;
  details?: unknown;
  status: number;

  constructor(payload: ApiErrorPayload, status: number) {
    super(payload.message);
    this.name = "ApiError";
    this.code = payload.code;
    this.details = payload.details;
    this.status = status;
  }
}

export type ApiClient = {
  get<T = any>(path: string): Promise<T>;
  send<T = any>(method: string, path: string, body: unknown): Promise<T>;
};

async function decode(response: Response) {
  const value = await response.json().catch(() => ({ error: { code: "INVALID_RESPONSE", message: "Topical returned an invalid response." } }));
  if (!response.ok) throw new ApiError(value.error || { code: "HTTP_ERROR", message: `Request failed with ${response.status}.` }, response.status);
  return value;
}

export async function connectApi(fetcher: typeof fetch = fetch): Promise<{ api: ApiClient; bootstrap: any }> {
  const response = await fetcher("/api/v1/bootstrap", { headers: { Accept: "application/json" } });
  const bootstrap = await decode(response);
  const request = async (method: string, path: string, body?: unknown) => decode(await fetcher(`/api/v1${path}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json", "X-Topical-CSRF": bootstrap.csrfToken })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }));
  return {
    bootstrap,
    api: {
      get: (path) => request("GET", path),
      send: (method, path, body) => request(method, path, body)
    }
  };
}

export function queryString(values: Record<string, string | number | boolean | string[] | null | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) value.forEach((item) => query.append(key, item));
    else query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}
