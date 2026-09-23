import { timingSafeEqual } from "node:crypto";

export class ProxyPolicy {
  constructor(options) {
    this.credentials = options.credentials;
    this.ratePerMinute = options.ratePerMinute;
    this.perCredentialConcurrency = options.perCredentialConcurrency;
    this.globalConcurrency = options.globalConcurrency;
    this.dailyBudget = options.dailyBudget;
    this.budget = options.budget;
    this.persistBudget = options.persistBudget;
    this.now = options.now || (() => Date.now());
    this.active = 0;
    this.clients = new Map();
  }

  authenticate(value) {
    const raw = String(value || "").replace(/^Bearer /, "");
    const separator = raw.indexOf(".");
    if (separator < 1) return null;
    const id = raw.slice(0, separator);
    const expectedValue = this.credentials[id];
    if (typeof expectedValue !== "string" || expectedValue.length < 16) return null;
    const presented = Buffer.from(raw.slice(separator + 1));
    const expected = Buffer.from(expectedValue);
    return presented.length === expected.length && timingSafeEqual(presented, expected)
      ? id : null;
  }

  acquire(id) {
    const now = this.now();
    const day = new Date(now).toISOString().slice(0, 10);
    if (this.budget.day !== day) this.budget = { day, calls: 0 };
    const client = this.clients.get(id) || {
      tokens: this.ratePerMinute,
      updatedAt: now,
      active: 0
    };
    const elapsedMinutes = Math.max(0, now - client.updatedAt) / 60000;
    client.tokens = Math.min(this.ratePerMinute,
      client.tokens + elapsedMinutes * this.ratePerMinute);
    client.updatedAt = now;
    this.clients.set(id, client);
    if (this.active >= this.globalConcurrency ||
        client.active >= this.perCredentialConcurrency ||
        client.tokens < 1 || this.budget.calls >= this.dailyBudget) {
      return null;
    }
    client.tokens -= 1;
    const nextBudget = { day, calls: this.budget.calls + 1 };
    this.persistBudget(nextBudget);
    this.budget = nextBudget;
    client.active += 1;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      client.active -= 1;
      this.active -= 1;
    };
  }
}