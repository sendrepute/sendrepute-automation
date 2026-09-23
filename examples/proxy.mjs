import { createServer } from "node:http";
import { request } from "node:https";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { ProxyPolicy } from "./proxy-policy.mjs";

const MAX_BYTES = 1024 * 1024;
const enabled = process.env.SENDREPUTE_ENABLED === "true";
const paidConsent = process.env.SENDREPUTE_PAID_CONSENT === "true";
const apiToken = process.env.SENDREPUTE_API_TOKEN || "";
const port = Number(process.env.PORT || 8787);
const credentials = JSON.parse(process.env.SENDREPUTE_PROXY_CREDENTIALS || "{}");
const ratePerMinute = Number(process.env.SENDREPUTE_RATE_PER_MINUTE || 0);
const perCredentialConcurrency = Number(process.env.SENDREPUTE_PER_CREDENTIAL_CONCURRENCY || 0);
const globalConcurrency = Number(process.env.SENDREPUTE_GLOBAL_CONCURRENCY || 0);
const dailyBudget = Number(process.env.SENDREPUTE_DAILY_CALL_BUDGET || 0);
const budgetFile = process.env.SENDREPUTE_BUDGET_FILE || "";
const maxConnections = Number(process.env.SENDREPUTE_MAX_CONNECTIONS || 20);
let initialBudget = { day: "", calls: 0 };
let budgetStateValid = true;
try {
  initialBudget = JSON.parse(readFileSync(budgetFile, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") budgetStateValid = false;
}
budgetStateValid = budgetStateValid && initialBudget &&
  typeof initialBudget.day === "string" &&
  Number.isInteger(initialBudget.calls) && initialBudget.calls >= 0;
const configured = enabled && paidConsent && apiToken && budgetFile &&
  budgetStateValid &&
  Object.keys(credentials).length > 0 &&
  [ratePerMinute, perCredentialConcurrency, globalConcurrency, dailyBudget, maxConnections]
    .every((value) => Number.isInteger(value) && value > 0);
const policy = new ProxyPolicy({
  credentials,
  ratePerMinute,
  perCredentialConcurrency,
  globalConcurrency,
  dailyBudget,
  budget: initialBudget,
  persistBudget(next) {
    const temporary = `${budgetFile}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
    renameSync(temporary, budgetFile);
  }
});

function classify(payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload));
    const req = request({
      protocol: "https:",
      hostname: "www.sendrepute.com",
      port: 443,
      path: "/api/v1/classify",
      method: "POST",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
        "content-length": body.length
      },
      timeout: 10000,
      agent: false
    }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) {
          req.destroy(new Error("Upstream response exceeds 1 MiB"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Upstream returned ${res.statusCode}`));
          return;
        }
        resolve(Buffer.concat(chunks));
      });
    });
    req.once("socket", (socket) => {
      const connectDeadline = setTimeout(() => req.destroy(new Error("TLS connect timeout")), 3000);
      socket.once("secureConnect", () => clearTimeout(connectDeadline));
      req.once("close", () => clearTimeout(connectDeadline));
    });
    const responseDeadline = setTimeout(() => req.destroy(new Error("Upstream total timeout")), 10000);
    req.once("close", () => clearTimeout(responseDeadline));
    req.once("timeout", () => req.destroy(new Error("Upstream response timeout")));
    req.once("error", reject);
    req.end(body);
  });
}

const server = createServer((req, res) => {
  if (!configured) {
    res.writeHead(503).end("Paid classification disabled");
    return;
  }
  const credentialId = policy.authenticate(req.headers.authorization);
  if (req.method !== "POST" || req.url !== "/classify" || !credentialId) {
    res.writeHead(404).end("Not found");
    return;
  }
  if (Number(req.headers["content-length"] || 0) > MAX_BYTES) {
    res.writeHead(413).end("Request too large");
    return;
  }
  const chunks = [];
  let bytes = 0;
  let tooLarge = false;
  req.on("data", (chunk) => {
    if (tooLarge) return;
    bytes += chunk.length;
    if (bytes > MAX_BYTES) {
      tooLarge = true;
      res.writeHead(413, { connection: "close" });
      res.end("Request too large", () => req.destroy());
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", async () => {
    if (tooLarge) return;
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const keys = value && typeof value === "object" && !Array.isArray(value)
        ? Object.keys(value) : [];
      if (keys.length !== 3 || !["sender", "subject", "body"].every((key) => keys.includes(key)) ||
          typeof value.sender !== "string" || value.sender.length < 1 || value.sender.length > 320 ||
          typeof value.subject !== "string" || value.subject.length < 1 || value.subject.length > 998 ||
          typeof value.body !== "string" || value.body.length < 1 || value.body.length > 524288) {
        res.writeHead(400).end("Invalid classify input");
        return;
      }
      let release;
      try {
        release = policy.acquire(credentialId);
      } catch {
        res.writeHead(503).end("Budget state unavailable");
        return;
      }
      if (!release) {
        res.writeHead(429, { "retry-after": "60" }).end("Proxy limit reached");
        return;
      }
      try {
        const response = await classify(value);
        res.writeHead(200, { "content-type": "application/json", "content-length": response.length });
        res.end(response);
      } finally {
        release();
      }
    } catch {
      res.writeHead(502).end("Classification failed");
    }
  });
});

server.headersTimeout = 5000;
server.requestTimeout = 10000;
server.timeout = 10000;
server.keepAliveTimeout = 2000;
server.maxConnections = maxConnections;
server.listen(port, "127.0.0.1");