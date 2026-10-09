import { createServer } from "node:http";
import { CustomerApiClient } from "./client.mjs";
import { createCustomerApiAdmin } from "./admin.mjs";
import { FileIntentStore } from "./intent-store.mjs";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Start the operator console. Binds to loopback by default. Binding any other
 * interface requires tlsTerminated: true, meaning an HTTPS reverse proxy fronts
 * this listener; the session cookie is then marked Secure.
 */
export async function startCustomerApiConsole({
  apiKey = process.env.SENDREPUTE_API_KEY,
  operatorToken = process.env.SENDREPUTE_CONSOLE_OPERATOR_TOKEN,
  host = process.env.SENDREPUTE_CONSOLE_HOST || "127.0.0.1",
  port = Number(process.env.SENDREPUTE_CONSOLE_PORT || 8787),
  tlsTerminated = process.env.SENDREPUTE_CONSOLE_TLS_TERMINATED === "1",
  handoffReturnOrigin = process.env.SENDREPUTE_HANDOFF_RETURN_ORIGIN || null,
  product = "SendRepute integration",
  basePath = "/sendrepute-admin",
  // Durable paid-intent ledger. Without it, paid and billing operations stay disabled.
  intentDirectory = process.env.SENDREPUTE_CONSOLE_INTENT_DIR || null,
  intentSingleHost = process.env.SENDREPUTE_CONSOLE_INTENT_SINGLE_HOST === "1",
  intentStore = null,
  fetch
} = {}) {
  if (!LOOPBACK.has(host) && !tlsTerminated) throw new Error("Refusing to expose the console on a non-loopback interface without TLS termination");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port");
  const client = new CustomerApiClient({ apiKey, ...(fetch ? { fetch } : {}) });
  const store = intentStore || (intentDirectory ? new FileIntentStore({ directory: intentDirectory, singleHost: intentSingleHost }) : null);
  const admin = createCustomerApiAdmin({ client, operatorTokens: [operatorToken], product, basePath, handoffReturnOrigin, secureCookie: tlsTerminated, intentStore: store });
  const server = createServer(async (req, res) => {
    if (await admin(req, res)) return;
    if (req.url === "/") { res.writeHead(302, { Location: basePath }); res.end(); return; }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 150000;
  await new Promise((resolve) => server.listen(port, host, resolve));
  return server;
}
