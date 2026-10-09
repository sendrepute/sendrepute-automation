import { getOperation } from "./catalog.mjs";

export const MAX_BODY_BYTES = 512 * 1024;
export const QUOTE_TTL_MS = 15 * 60 * 1000;

export class PolicyError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "PolicyError";
    this.status = status;
    this.code = code;
  }
}

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

function getPath(obj, dotted) {
  return dotted.split(".").reduce((acc, k) => (isPlain(acc) ? acc[k] : undefined), obj);
}

function checkParam(def, value) {
  if (def.type === "integer" || def.type === "number") {
    const n = typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value;
    if (!Number.isSafeInteger(n)) throw new PolicyError(400, "INVALID_PARAMETER", `${def.name} must be a whole number`);
    if (def.minimum != null && n < def.minimum) throw new PolicyError(400, "INVALID_PARAMETER", `${def.name} is below the minimum`);
    if (def.maximum != null && n > def.maximum) throw new PolicyError(400, "INVALID_PARAMETER", `${def.name} exceeds the maximum`);
    return String(n);
  }
  if (typeof value !== "string" || value.length < 1 || value.length > (def.maxLength || 128)) {
    throw new PolicyError(400, "INVALID_PARAMETER", `${def.name} is invalid`);
  }
  if (def.enum && !def.enum.includes(value)) throw new PolicyError(400, "INVALID_PARAMETER", `${def.name} is not an allowed value`);
  if (def.pattern && !new RegExp(def.pattern).test(value)) throw new PolicyError(400, "INVALID_PARAMETER", `${def.name} has an invalid format`);
  return value;
}

/**
 * Validate one customer API call against the generated catalog.
 * options.paidConsent  {acknowledged:true, expectedPriceMillicents:int} for paid operations
 * options.confirm      true for financial operations
 * options.quotedAt     timestamp of the matching quote (admin surfaces); null skips the check
 * options.requireQuote enforce quote recency (admin surfaces)
 * options.handoffReturnOrigin server-configured origin for hosted builder handoffs
 * options.enabled      optional Set of enabled operation ids
 */
export function prepareCall(operationId, input = {}, options = {}) {
  const op = getOperation(operationId);
  if (!op) throw new PolicyError(404, "UNKNOWN_OPERATION", "Operation is not part of the customer API catalog");
  if (options.enabled && !options.enabled.has(op.id)) throw new PolicyError(403, "OPERATION_DISABLED", "Operation is disabled on this server");
  if (!isPlain(input)) throw new PolicyError(400, "INVALID_INPUT", "Call input must be an object");
  const params = input.params ?? {};
  const query = input.query ?? {};
  if (!isPlain(params) || !isPlain(query)) throw new PolicyError(400, "INVALID_INPUT", "params and query must be objects");

  let path = op.path;
  const search = new URLSearchParams();
  const defs = op.params || [];
  for (const key of Object.keys(params)) if (!defs.some((d) => d.in === "path" && d.name === key)) throw new PolicyError(400, "UNKNOWN_PARAMETER", `Unknown path parameter ${key}`);
  for (const key of Object.keys(query)) if (!defs.some((d) => d.in === "query" && d.name === key)) throw new PolicyError(400, "UNKNOWN_PARAMETER", `Unknown query parameter ${key}`);
  for (const def of defs) {
    const source = def.in === "path" ? params : query;
    if (source[def.name] === undefined || source[def.name] === "") {
      if (def.in === "path") throw new PolicyError(400, "MISSING_PARAMETER", `${def.name} is required`);
      continue;
    }
    const value = checkParam(def, source[def.name]);
    if (def.in === "path") path = path.replace(`{${def.name}}`, encodeURIComponent(value));
    else search.set(def.name, value);
  }

  let body;
  if (op.hasBody) {
    body = input.body ?? {};
    if (!isPlain(body)) throw new PolicyError(400, "INVALID_BODY", "Request body must be a JSON object");
    body = JSON.parse(JSON.stringify(body));
    for (const key of Object.keys(body)) if (!op.bodyFields.includes(key)) throw new PolicyError(400, "UNKNOWN_FIELD", `Unsupported body field ${key}`);
    if (op.id === "customerCreateVipEmailTemplate" && Array.isArray(body.imageUrls) && body.imageUrls.length > 0) {
      throw new PolicyError(400, "URLS_REFUSED", "imageUrls are refused by this integration; arbitrary URLs are not forwarded");
    }
    if (op.handoff) {
      if (!options.handoffReturnOrigin) throw new PolicyError(403, "HANDOFF_NOT_CONFIGURED", "Hosted builder handoff requires a configured return origin");
      if (body.returnOrigin && body.returnOrigin !== options.handoffReturnOrigin) throw new PolicyError(400, "RETURN_ORIGIN_FIXED", "returnOrigin is fixed by server configuration");
      body.returnOrigin = options.handoffReturnOrigin;
    }
  } else if (input.body !== undefined && input.body !== null) {
    throw new PolicyError(400, "UNEXPECTED_BODY", "This operation does not accept a request body");
  }

  if (op.paid) {
    const consent = options.paidConsent;
    const classification = op.id === CLASSIFY_OPERATION;
    if (!isPlain(consent) || consent.acknowledged !== true) {
      throw new PolicyError(428, "CONSENT_REQUIRED", "Paid operation requires explicit consent to an expected price in millicents");
    }
    const auth = classification ? classificationAuthorization(consent, body) : null;
    if (!classification && (!Number.isSafeInteger(consent.expectedPriceMillicents) || consent.expectedPriceMillicents < 0)) {
      throw new PolicyError(428, "CONSENT_REQUIRED", "Paid operation requires explicit consent to an expected price in millicents");
    }
    if (options.requireQuote) {
      if (!options.quotedAt || (options.now ?? Date.now()) - options.quotedAt > QUOTE_TTL_MS) {
        throw new PolicyError(428, "QUOTE_REQUIRED", `Run ${op.quote} in this session within 15 minutes before this paid operation`);
      }
    }
    if (classification) {
      // Console: the confirmed schedule must equal the rates the server returned to this session's latest quote.
      if (options.expectedPricing !== undefined && !sameRates(options.expectedPricing, auth.expectedPricing)) {
        throw new PolicyError(409, "PRICE_CONFIRMATION_STALE", "The confirmed rates no longer match the latest GET /v1/pricing result in this session. Load current rates and confirm again.");
      }
      // The server re-checks the schedule and ceiling atomically at settlement.
      body.priceAuthorization = auth;
    } else if (op.priceField) {
      const parts = op.priceField.split(".");
      const current = getPath(body, op.priceField);
      if (current === undefined || current === null || current === "") {
        let target = body;
        for (const k of parts.slice(0, -1)) {
          if (!isPlain(target[k])) throw new PolicyError(400, "PRICE_AUTHORIZATION_REQUIRED", `${parts.slice(0, -1).join(".")} must be supplied for this paid operation`);
          target = target[k];
        }
        target[parts.at(-1)] = consent.expectedPriceMillicents;
      } else if (current !== consent.expectedPriceMillicents) {
        throw new PolicyError(409, "PRICE_MISMATCH", `${op.priceField} differs from the consented price`);
      }
    }
    if (op.consentFlag) body[op.consentFlag] = true;
  }
  if (op.financial && options.confirm !== true) throw new PolicyError(428, "CONFIRMATION_REQUIRED", "This billing or recovery action requires explicit confirmation");

  let serialized;
  if (op.hasBody) {
    serialized = JSON.stringify(body);
    if (Buffer.byteLength(serialized) > MAX_BODY_BYTES) throw new PolicyError(413, "BODY_TOO_LARGE", "Request body exceeds 512 KiB");
  }
  const qs = search.toString();
  return { op, method: op.method, path: path + (qs ? `?${qs}` : ""), body: serialized };
}

const PRICE_KEYS = ["expectedPriceMillicents", "priceMillicents", "quotedPriceMillicents", "totalPriceMillicents", "chargeMillicents", "maximumChargeMillicents", "amountMillicents"];
export const CLASSIFY_OPERATION = "classifyCustomerEmail";
export const CLASSIFICATION_RATE_FIELDS = ["classificationBaseMillicents", "includedUniqueTerms", "additionalTermMillicents", "maximumClassificationMillicents"];
const safeInt = (v) => Number.isSafeInteger(v) && v >= 0;

/** The four effective classification rates from a GET /v1/pricing response, or null. */
export function classificationRates(data) {
  if (!isPlain(data)) return null;
  const out = {};
  for (const f of CLASSIFICATION_RATE_FIELDS) { if (!safeInt(data[f])) return null; out[f] = data[f]; }
  return out;
}

function sameRates(a, b) {
  return isPlain(a) && isPlain(b) && CLASSIFICATION_RATE_FIELDS.every((f) => a[f] === b[f]);
}

/**
 * Build the exact CustomerClassificationPriceAuthorization: the full effective
 * rate schedule plus a per-request ceiling. Accepts consent as
 * { expectedPricing, maxChargeMillicents } or (legacy) a complete
 * body.priceAuthorization whose ceiling equals expectedPriceMillicents.
 */
function classificationAuthorization(consent, body) {
  const supplied = body.priceAuthorization;
  const strict = (v) => isPlain(v) && Object.keys(v).length === 2 && isPlain(v.expectedPricing) && Object.keys(v.expectedPricing).length === 4 && classificationRates(v.expectedPricing) && safeInt(v.maxChargeMillicents);
  let auth;
  if (consent.expectedPricing !== undefined || consent.maxChargeMillicents !== undefined) {
    const rates = isPlain(consent.expectedPricing) && Object.keys(consent.expectedPricing).length === 4 ? classificationRates(consent.expectedPricing) : null;
    if (!rates || !safeInt(consent.maxChargeMillicents)) throw new PolicyError(428, "CONSENT_REQUIRED", "Classification consent needs the four effective rates from GET /v1/pricing and a maximum charge in millicents");
    auth = { expectedPricing: rates, maxChargeMillicents: consent.maxChargeMillicents };
  } else if (safeInt(consent.expectedPriceMillicents) && strict(supplied)) {
    auth = { expectedPricing: classificationRates(supplied.expectedPricing), maxChargeMillicents: supplied.maxChargeMillicents };
    if (auth.maxChargeMillicents !== consent.expectedPriceMillicents) throw new PolicyError(409, "PRICE_MISMATCH", "priceAuthorization.maxChargeMillicents differs from the consented price");
  } else {
    throw new PolicyError(428, "CONSENT_REQUIRED", "Classification consent needs the four effective rates from GET /v1/pricing and a maximum charge in millicents");
  }
  if (supplied !== undefined && supplied !== null && !(strict(supplied) && sameRates(supplied.expectedPricing, auth.expectedPricing) && supplied.maxChargeMillicents === auth.maxChargeMillicents)) {
    throw new PolicyError(409, "PRICE_MISMATCH", "body.priceAuthorization differs from the consented rates or ceiling");
  }
  return auth;
}

export function extractQuotedPrice(data, depth = 0) {
  if (!data || typeof data !== "object" || depth > 4) return null;
  for (const key of PRICE_KEYS) if (Number.isSafeInteger(data[key])) return data[key];
  for (const value of Object.values(data)) {
    const found = extractQuotedPrice(value, depth + 1);
    if (found !== null) return found;
  }
  return null;
}
