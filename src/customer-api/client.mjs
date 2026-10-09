import { createHash } from "node:crypto";
import { OPERATIONS } from "./catalog.mjs";
import { prepareCall } from "./policy.mjs";

export const CUSTOMER_API_BASE = "https://www.sendrepute.com/api";
const KEY = /^[A-Za-z0-9._~+\/=-]{16,512}$/;

export class CustomerApiError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = "CustomerApiError";
    this.code = code;
    this.status = status;
  }
}

function header(headers, name) {
  const v = headers.get(name);
  if (v === null || !/^\d{1,12}$/.test(v)) return undefined;
  return Number(v);
}

/**
 * Programmatic client for all customer API operations. The bearer key stays in
 * this process; the origin is fixed to the SendRepute HTTPS endpoint, redirects
 * are refused, responses are size-capped, and nothing is retried automatically.
 */
export class CustomerApiClient {
  #key;
  #fetch;
  #timeoutMs;
  #maxBytes;

  constructor({ apiKey, fetch: fetchImpl = globalThis.fetch, timeoutMs = 20000, maxResponseBytes = 8 * 1024 * 1024 } = {}) {
    if (typeof apiKey !== "string" || !KEY.test(apiKey)) throw new CustomerApiError("CONFIGURATION", "A SendRepute customer API key is required");
    if (typeof fetchImpl !== "function") throw new CustomerApiError("CONFIGURATION", "fetch is unavailable");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new CustomerApiError("CONFIGURATION", "timeoutMs must be 1000-120000");
    if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 16 * 1024 * 1024) throw new CustomerApiError("CONFIGURATION", "maxResponseBytes must be 1 KiB-16 MiB");
    this.#key = apiKey;
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
    this.#maxBytes = maxResponseBytes;
    for (const op of OPERATIONS) {
      if (!(op.id in this)) Object.defineProperty(this, op.id, { value: (input = {}, options = {}) => this.call(op.id, input, options), enumerable: false });
    }
  }

  toJSON() { return { type: "CustomerApiClient" }; }

  /** One-way identity of the configured credential, used to scope durable intents. */
  credentialFingerprint() { return createHash("sha256").update(`sendrepute-credential-v1\n${this.#key}`).digest("hex"); }

  /** Validate and run one operation. Paid operations require options.paidConsent. */
  async call(operationId, input = {}, options = {}) {
    const prepared = prepareCall(operationId, input, options);
    return this.send(prepared);
  }

  async send(prepared) {
    const url = new URL(CUSTOMER_API_BASE + prepared.path);
    if (url.protocol !== "https:" || url.origin !== new URL(CUSTOMER_API_BASE).origin) throw new CustomerApiError("TRANSPORT", "Refusing a non-SendRepute destination");
    const headers = { Accept: "application/json", Authorization: `Bearer ${this.#key}` };
    if (prepared.body !== undefined) headers["Content-Type"] = "application/json";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response;
    try {
      response = await this.#fetch(url.href, { method: prepared.method, headers, body: prepared.body, redirect: "manual", signal: controller.signal, credentials: "omit" });
    } catch {
      clearTimeout(timer);
      throw new CustomerApiError("TRANSPORT", "SendRepute request failed before a response was received. It was not retried.");
    }
    try {
      if (response.status >= 300 && response.status < 400 || response.type === "opaqueredirect") throw new CustomerApiError("TRANSPORT", "Redirects are refused to protect the API key", response.status);
      const declared = header(response.headers, "content-length");
      if (declared !== undefined && declared > this.#maxBytes) throw new CustomerApiError("RESPONSE_TOO_LARGE", "Response exceeds the configured size limit", response.status);
      let text = "";
      if (response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > this.#maxBytes) { await reader.cancel().catch(() => {}); throw new CustomerApiError("RESPONSE_TOO_LARGE", "Response exceeds the configured size limit", response.status); }
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      }
      let data = null;
      if (text) {
        const type = response.headers.get("content-type") || "";
        if (!/^application\/(?:[a-z.+-]*\+)?json\b/i.test(type)) throw new CustomerApiError("MALFORMED_RESPONSE", "SendRepute returned a non-JSON response", response.status);
        try { data = JSON.parse(text); } catch { throw new CustomerApiError("MALFORMED_RESPONSE", "SendRepute returned invalid JSON", response.status); }
      }
      return {
        status: response.status,
        ok: response.status >= 200 && response.status < 300,
        data,
        rateLimit: {
          limit: header(response.headers, "x-ratelimit-limit"),
          remaining: header(response.headers, "x-ratelimit-remaining"),
          reset: header(response.headers, "x-ratelimit-reset"),
          retryAfter: header(response.headers, "retry-after")
        }
      };
    } catch (error) {
      if (error instanceof CustomerApiError) throw error;
      throw new CustomerApiError("TRANSPORT", "SendRepute response could not be read. It was not retried.", response.status);
    } finally {
      clearTimeout(timer);
    }
  }
}
