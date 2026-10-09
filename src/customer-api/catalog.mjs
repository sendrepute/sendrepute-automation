// Operation catalog generated from artifacts/api-server/src/customer-api-openapi.json.
// Regenerate the JSON file when the contract changes; tests compare it with the source.
import { readFileSync } from "node:fs";

const raw = JSON.parse(readFileSync(new URL("./customer-api-operations.json", import.meta.url), "utf8"));
export const API_VERSION = raw.apiVersion;
export const OPERATIONS = Object.freeze(raw.operations.map((op) => Object.freeze(op)));
const byId = new Map(OPERATIONS.map((op) => [op.id, op]));
export const QUOTE_OPERATIONS = new Set(OPERATIONS.filter((op) => op.quote).map((op) => op.quote));

export function getOperation(id) {
  return typeof id === "string" ? byId.get(id) || null : null;
}
