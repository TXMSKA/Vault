// A synthetic Quantum for tests: token, revoke, me, usage, datasets and objects with the writer rule. Shared by the service tests and the app smoke.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

// Tokens and codes remain inside this fixture; only fixed test locations reach output.
export async function fakeQuantum() {
  const accounts = new Map(), codes = new Map(), access = new Map(), refresh = new Map(), requests = [], credentials = [];
  const counters = { signin: 0, refresh: 0, revoke: 0, pages: 0, usage: 0, foreign: 0, busy: 0 }, controls = { busy: 0, unavailable: false, badHash: false, lostDatasetResponse: 0, postCreateListingFailure: 0, objectWriteFailure: 0 };
  const account = email => { if (!accounts.has(email)) accounts.set(email, { email, datasets: new Map(), plan: true, full: false, refuseRefresh: false }); return accounts.get(email); };
  const opaque = () => { const value = randomBytes(32).toString("base64url"); credentials.push(value); return value; };
  const pair = chain => { const accessToken = opaque(), refreshToken = opaque(); access.set(accessToken, { chain, expired: false }); refresh.set(refreshToken, { chain, used: false }); return { accessToken, refreshToken, tokenType: "Bearer", expiresIn: 900, deviceId: chain.registration }; };
  const json = (res, code, value) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
  const error = (res, status, code) => json(res, status, { error: { code, message: "Synthetic Quantum failure", fields: {}, requestId: randomUUID() } });
  const body = async req => { const parts = []; for await (const part of req) parts.push(part); return Buffer.concat(parts); };
  const server = createServer((req, res) => { void (async () => {
    const url = new URL(req.url, "http://127.0.0.1"), path = url.pathname, method = req.method;
    if (path === "/v1/oauth/token" && method === "POST") {
      const input = JSON.parse((await body(req)).toString()); if (input.appId !== "vault") return error(res, 400, "invalid_request");
      if (input.grantType === "authorization_code") {
        credentials.push(input.codeVerifier);
        const issued = codes.get(input.code); codes.delete(input.code);
        if (!issued || issued.until < Date.now() || issued.redirect !== input.redirectUri || createHash("sha256").update(input.codeVerifier).digest("base64url") !== issued.challenge) return error(res, 400, "invalid_grant");
        return json(res, 200, pair({ account: account(issued.email), computer: issued.computer, registration: randomUUID(), revoked: false }));
      }
      if (input.grantType === "refresh_token") {
        counters.refresh++; const previous = refresh.get(input.refreshToken);
        if (!previous) return error(res, 400, "invalid_grant");
        if (previous.used) previous.chain.revoked = true;
        if (previous.used || previous.chain.revoked || previous.chain.account.refuseRefresh) return error(res, 400, "invalid_grant");
        previous.used = true; return json(res, 200, pair(previous.chain));
      }
      return error(res, 400, "invalid_request");
    }
    const raw = String(req.headers.authorization ?? "").replace(/^Bearer /, ""), token = access.get(raw);
    if (!token || token.expired || token.chain.revoked) return error(res, 401, "unauthorized");
    const chain = token.chain, owner = chain.account; requests.push({ method, path, computer: chain.computer });
    if (path === "/v1/oauth/revoke" && method === "POST") { chain.revoked = true; counters.revoke++; return json(res, 200, { success: true }); }
    if (path === "/v1/me" && method === "GET") return json(res, 200, { email: owner.email });
    if (path === "/v1/usage" && method === "GET") { counters.usage++; return json(res, 200, { poolBytes: 100000000, usedBytes: [...owner.datasets.values()].reduce((sum, dataset) => sum + [...dataset.values()].reduce((size, row) => size + row.bytes.length, 0), 0) }); }
    if (controls.unavailable) return error(res, 503, "storage_unavailable");
    if (controls.busy > 0) { controls.busy--; counters.busy++; res.setHeader("Retry-After", "0.01"); return error(res, 429, "rate_limited"); }
    if (!owner.plan) return error(res, 403, "sync_plan_required");
    if (path === "/v1/datasets" && method === "GET") {
      const all = [...owner.datasets.keys()].sort().filter(id => !url.searchParams.get("after") || id > url.searchParams.get("after")), page = all.slice(0, Math.min(2, Number(url.searchParams.get("limit") ?? 1000)));
      return json(res, 200, { datasets: page.map(id => ({ id, appId: "vault", createdAt: new Date(0).toISOString() })), after: all.length > page.length ? page.at(-1) : null });
    }
    const match = /^\/v1\/datasets\/([^/]+)(?:\/objects(?:\/(.*))?)?$/.exec(path);
    if (!match) return error(res, 404, "not_found"); const id = decodeURIComponent(match[1]);
    if (!path.includes("/objects") && method === "PUT") { const exists = owner.datasets.has(id); if (!exists) owner.datasets.set(id, new Map()); if (controls.postCreateListingFailure > 0) { controls.postCreateListingFailure--; owner.failListing = true; } if (controls.lostDatasetResponse > 0) { controls.lostDatasetResponse--; return res.destroy(); } return json(res, exists ? 200 : 201, { id, appId: "vault", createdAt: new Date(0).toISOString() }); }
    const dataset = owner.datasets.get(id); if (!dataset) return error(res, 404, "not_found");
    if (match[2] === undefined && method === "GET") {
      if (owner.failListing) { owner.failListing = false; return error(res, 503, "storage_unavailable"); }
      const prefix = url.searchParams.get("prefix") ?? "", after = url.searchParams.get("after"), all = [...dataset.keys()].sort().filter(name => name.startsWith(prefix) && (!after || name > after)), page = all.slice(0, Math.min(2, Number(url.searchParams.get("limit") ?? 1000)));
      if (after) counters.pages++; return json(res, 200, { objects: page.map(path => { const row = dataset.get(path); return { path, size: row.bytes.length, sha256: digest(row.bytes), createdAt: new Date(0).toISOString() }; }), after: all.length > page.length ? page.at(-1) : null });
    }
    const name = decodeURIComponent(match[2] ?? ""), previous = dataset.get(name);
    if (["PUT", "DELETE"].includes(method) && name.startsWith("writers/") && name.split("/")[1] !== chain.computer) { counters.foreign++; return error(res, 403, "writer_forbidden"); }
    if (method === "GET") { if (!previous) return error(res, 404, "not_found"); res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": previous.bytes.length, "X-Content-SHA256": controls.badHash ? "0".repeat(64) : digest(previous.bytes) }); return res.end(previous.bytes); }
    if (method === "PUT") {
      const bytes = await body(req); if (req.headers["content-type"] !== "application/octet-stream" || Number(req.headers["content-length"]) !== bytes.length || req.headers["x-content-sha256"] !== digest(bytes)) return error(res, 400, "invalid_request");
      if (controls.objectWriteFailure > 0) { controls.objectWriteFailure--; return error(res, 503, "storage_unavailable"); }
      if (bytes.length > (name.includes("/blobs/") ? 64 * 1024 : 8 * 1024 * 1024)) return error(res, 413, "object_too_large");
      if (previous) return previous.bytes.equals(bytes) ? json(res, 200, { success: true }) : error(res, 409, "object_conflict");
      if (owner.full) return error(res, 409, "pool_exceeded");
      const own = [...dataset.keys()].filter(path => path.startsWith(`writers/${chain.computer}/`)).map(path => path.split("/")[2]); if (name.startsWith("writers/") && !own.includes(name.split("/")[2]) && new Set(own).size >= 64) return error(res, 409, "writer_limit_exceeded");
      dataset.set(name, { bytes: Buffer.from(bytes) }); return json(res, 201, { success: true });
    }
    if (method === "DELETE") { if (!previous) return error(res, 404, "not_found"); dataset.delete(name); return json(res, 200, { success: true }); }
    return error(res, 404, "not_found");
  })().catch(() => { if (!res.headersSent) error(res, 500, "storage_unavailable"); else res.destroy(); }); });
  await new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
  const api = `http://127.0.0.1:${server.address().port}`;
  return {
    api, account, counters, controls, requests, credentials,
    issue(url, email) { counters.signin++; const authorize = new URL(url), redirect = authorize.searchParams.get("redirectUri"), challenge = authorize.searchParams.get("codeChallenge"), computer = authorize.searchParams.get("computerId"), code = opaque(); assert.equal(authorize.origin, api); assert.equal(authorize.pathname, "/authorize"); assert.equal(authorize.searchParams.get("appId"), "vault"); assert.equal(/^http:\/\/127\.0\.0\.1:[1-9][0-9]*\/callback$/.test(redirect), true); assert.equal(/^[A-Za-z0-9_-]{43}$/.test(challenge), true); assert.equal(Boolean(computer), true); assert.equal((authorize.searchParams.get("deviceName") ?? "").length <= 128, true); codes.set(code, { email, redirect, challenge, computer, until: Date.now() + 60000 }); const callback = new URL(redirect); callback.searchParams.set("code", code); return { callback, computer }; },
    expire(email) { for (const token of access.values()) if (token.chain.account.email === email) token.expired = true; },
    bearer(computer) { return [...access].findLast(([, token]) => token.chain.computer === computer && !token.expired && !token.chain.revoked)?.[0]; },
    async close() { server.closeAllConnections(); await new Promise(done => server.close(done)); },
  };
}
