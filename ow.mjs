#!/usr/bin/env node
// OW CLI. Sits next to LiteLLM, tells the desk what the GPU can do, then takes a job.

import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as crypto from "node:crypto";

const exec = promisify(execFile);
const pool = (process.env.POOL_URL || "https://owterminal.com").replace(/\/$/, "");
const base = (process.env.LITELLM_BASE || "http://127.0.0.1:4000").replace(/\/+$/, "").replace(/\/v1$/, "");
const selection = (process.env.OW_MODELS || "").split(",").map(s => s.trim()).filter(Boolean);
const key = process.env.LITELLM_KEY || "";
// Unset: the desk suggests a price per model (uncensored builds at a premium,
// official ones at the market reference). Set OW_PRICE (cents per million) to override.
const price = process.env.OW_PRICE ? Number(process.env.OW_PRICE) : null;
const home = process.env.OW_HOME || join(homedir(), ".ow");
const statePath = join(home, "nodes.json");
const encKeyPath = join(home, "enckey.json");
const pidPath = join(home, "serve.pid");
const headers = {
  "content-type": "application/json",
  ...(key ? { authorization: `Bearer ${key}` } : {}),
};

// Prompts encrypted at rest (docs/PRIVACY-ARCHITECTURE.md). This CLI is a
// single dependency-free file run with bare `node`, so it cannot import
// @noble/*: every primitive here is a `node:crypto` builtin. The construction
// — X25519 ECDH, HKDF-SHA256, AES-256-GCM — is proven byte-identical to the
// pure-JS implementation the desk and the browser host share
// (src/lib/prompt-seal.ts) by src/lib/prompt-seal.test.ts's cross-
// implementation round trip. Do not change this without re-running that test.
function encKeypair() {
  try {
    const saved = JSON.parse(readFileSync(encKeyPath, "utf8"));
    if (typeof saved.publicKey === "string" && typeof saved.secretKey === "string") return saved;
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("Could not read the saved encryption key. Restore enckey.json before joining again.");
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  const keypair = {
    publicKey: publicKey.export({ format: "jwk" }).x,
    secretKey: privateKey.export({ format: "jwk" }).d,
  };
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const temporary = `${encKeyPath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(keypair), { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, encKeyPath);
  return keypair;
}

/** The node id the desk derives from a secret (openNode's `node_${sha256(secret).slice(0,8)}`) — recomputed locally so an already-registered node (saved before this CLI knew about `id`) still has it for unsealing. */
function nodeId(secret) {
  return `node_${crypto.createHash("sha256").update(secret).digest("hex").slice(0, 8)}`;
}

/** Decrypts a sealed job's prompt. Throws on any mismatched job id, node id, or key — never retry with different inputs. */
function unsealPrompt(envelope, wrapped, jobId, nodeId, secretKey, publicKey) {
  const open = (keyBuf, nonceB64, aad, ctB64, tagB64) => {
    const d = crypto.createDecipheriv("aes-256-gcm", keyBuf, Buffer.from(nonceB64, "base64url"));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(tagB64, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ctB64, "base64url")), d.final()]);
  };
  const priv = crypto.createPrivateKey({ key: { kty: "OKP", crv: "X25519", d: secretKey, x: publicKey }, format: "jwk" });
  const peerPub = crypto.createPublicKey({ key: { kty: "OKP", crv: "X25519", x: envelope.epk }, format: "jwk" });
  const shared = crypto.diffieHellman({ privateKey: priv, publicKey: peerPub });
  const salt = Buffer.concat([Buffer.from(envelope.epk, "base64url"), Buffer.from(publicKey, "base64url")]);
  const wrapKey = Buffer.from(crypto.hkdfSync("sha256", shared, salt, Buffer.from("owt-sealed-prompt-wrap-v1"), 32));
  const contentKey = open(wrapKey, wrapped.wrapNonce, `${jobId}:${nodeId}`, wrapped.wrappedKey, wrapped.wrapTag);
  return open(contentKey, envelope.nonce, jobId, envelope.ct, envelope.tag).toString("utf8");
}

function load() {
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
    if (!Array.isArray(parsed.nodes) || parsed.nodes.some(node => !node || typeof node.model !== "string" || !/^sk-node-[A-Za-z0-9_-]{32}$/.test(node.secret))) throw new Error("Invalid saved host keys");
    return parsed.nodes;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw new Error("Could not read saved host keys. Restore nodes.json before joining again.");
  }
}

function save(nodes) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ nodes }, null, 2), { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, statePath);
}

async function models({ strict = true } = {}) {
  const res = await fetch(`${base}/v1/models`, { headers, signal: AbortSignal.timeout(10000) });
  if (res.status === 401) throw new Error("LiteLLM wants LITELLM_KEY");
  if (!res.ok) throw new Error(`models ${res.status}`);
  const json = await res.json();
  const ids = [...new Set((json.data || []).map((row) => row.id).filter(id => typeof id === "string" && /^[a-zA-Z0-9._:/-]{1,80}$/.test(id)))];
  if (strict && selection.some(id => !ids.includes(id))) throw new Error("A selected OW_MODELS ID is missing from this server. Run ow models without OW_MODELS to see its IDs.");
  const chosen = selection.length ? ids.filter(id => selection.includes(id)) : ids;
  if (chosen.length > 24) throw new Error("Choose up to 24 models with OW_MODELS.");
  return chosen;
}

async function gpu() {
  try {
    const { stdout } = await exec("nvidia-smi", [
      "--query-gpu=name,memory.total,memory.used",
      "--format=csv,noheader,nounits",
    ]);
    const line = stdout.trim().split("\n")[0] || "";
    const [name, total, used] = line.split(",").map((part) => part.trim());
    const totalGb = Math.round(Number(total) / 1024);
    const usedGb = Math.round(Number(used) / 1024);
    return {
      chip: name || null,
      vram_gb: Number.isFinite(totalGb) ? totalGb : null,
      vram_used_gb: Number.isFinite(usedGb) ? usedGb : null,
      full: Number(total) > 0 && Number(used) / Number(total) > 0.92,
    };
  } catch {
    // No NVIDIA driver. On a Mac, report the Apple chip so the desk can match
    // the machine to its catalog device (market value, expected speed).
    if (process.platform === "darwin") {
      try {
        const { stdout } = await exec("sysctl", ["-n", "machdep.cpu.brand_string"]);
        const name = stdout.trim();
        if (name) return { chip: name.slice(0, 80), vram_gb: null, vram_used_gb: null, full: false };
      } catch {
        // fall through
      }
    }
    return { chip: null, vram_gb: null, vram_used_gb: null, full: false };
  }
}

async function probe(model) {
  const started = Date.now();
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(80000),
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 16,
      stream: false,
    }),
  });
  if (!res.ok) return null;
  const json = await res.json();
  const tokens = Number(json.usage?.completion_tokens || 0);
  const seconds = Math.max(0.05, (Date.now() - started) / 1000);
  if (tokens < 1) return null;
  return Math.max(1, Math.round(tokens / seconds));
}

function modelPrices() {
  let overrides;
  try { overrides = JSON.parse(process.env.OW_PRICES || "{}"); }
  catch { throw new Error('OW_PRICES must be a JSON object mapping model IDs to integer cents.'); }
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides) || Object.entries(overrides).some(([id,value]) => !/^[a-zA-Z0-9._:/-]{1,80}$/.test(id) || !Number.isInteger(value) || value < 1 || value > 5000)) throw new Error("OW_PRICES rates must be integer cents from 1 to 5000.");
  return overrides;
}

async function joinPool({ quiet = false, found: inventory } = {}) {
  if (price !== null && (!Number.isInteger(price) || price < 1 || price > 5000)) throw new Error("OW_PRICE must be integer cents from 1 to 5000.");
  const prices = modelPrices();
  const found = inventory ?? await models();
  if (!found.length) throw new Error("LiteLLM has no models loaded");
  const nodes = load();
  for (const model of found) {
    const already = nodes.find((row) => row.model === model);
    if (already) {
      if (!quiet && already.code) console.log(`${model} already on. Your code is ${already.code}`);
      continue;
    }
    const modelPrice = prices[model] ?? price;
    const res = await fetch(`${pool}/api/v1/node`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, ...(modelPrice === null ? {} : {price:modelPrice}), ...(nodes[0] ? {machineSecret:nodes[0].secret} : {}), enc_pubkey: encKeypair().publicKey }),
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.secret) throw new Error(json.error || `join ${model} ${res.status}`);
    nodes.push({ model, secret: json.secret, code: json.code, price: json.price ?? prices[model] ?? price });
    save(nodes); // Never lose earlier keys if a later model fails to register.
    if (!quiet) {
      console.log(model);
      console.log(`Price $${(Number(json.price) / 100).toFixed(2)} per million tokens${json.price_basis && json.price_basis !== "host" ? " (suggested; set OW_PRICE to change)" : ""}`);
      console.log(`Your code is ${json.code}`);
      console.log("Registered. Run ow serve for a pool test, then ow status to confirm readiness.");
    }
  }
  save(nodes);
  return nodes.filter((row) => found.includes(row.model));
}

// Parallel jobs this machine takes (OW_SLOTS, 1 to 8). Engines like vLLM and
// llama.cpp's server run several conversations at once for far more total
// output; 1 keeps the one-at-a-time behavior.
const slots = Math.max(1, Math.min(8, Math.floor(Number(process.env.OW_SLOTS)) || 1));
// Opt-in: OW_WAIT=<seconds> (1-15) makes a one-model host ask the desk to hold
// an empty claim open that long and answer as soon as a job lands. Off by
// default until the desk can see a host disconnect mid-hold (see
// docs/DISPATCH-PLAN.md). A desk without held claims ignores the header; the
// loop still never claims more often than every 2 s unless the desk held.
const wait = Math.max(0, Math.min(15, Number(process.env.OW_WAIT ?? 0) || 0));

// Opt-in host relay (docs/DISPATCH-PLAN.md): OW_RELAY=1 opens one OUTBOUND
// WebSocket per selected model to the desk's relay, so the desk can say
// "claim now" the moment a job lands and the reply can stream to the caller.
// No public IP, no open port; works behind CGNAT. Polling stays the fallback
// whenever a socket is down. The relay's whole vocabulary toward this host is
// three exact strings: it can only say "ready", "claim" (for the model of the
// socket it arrives on) or "pong". Anything else closes the socket. Nothing
// received over it can change which engine (LITELLM_BASE), desk (POOL_URL) or
// relay this process talks to, and prompts never travel over it: every job is
// fetched over HTTPS from jobs/claim, exactly as without the relay.
const relayOn = process.env.OW_RELAY === "1";
const RELAY_PROTOCOL = "owt-relay.v1";
const RELAY_READY = '{"v":1,"t":"ready"}';
const RELAY_CLAIM = '{"v":1,"t":"claim"}';
const RELAY_PING = '{"v":1,"t":"ping"}';
const RELAY_PONG = '{"v":1,"t":"pong"}';
// A ring makes at most one claim per model per half second, whatever the relay sends.
const RING_FLOOR_MS = 500;
// With every socket up, still look for work this often in case a ring is lost.
const RELAY_SAFETY_POLL_MS = 10000;

function relayEndpoint() {
  let url;
  try { url = new URL(process.env.OW_RELAY_URL || "wss://relay.owterminal.com/v1/connect"); }
  catch { throw new Error("OW_RELAY_URL must be a wss:// URL."); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback)) throw new Error("OW_RELAY_URL must be a wss:// URL.");
  if (url.username || url.password) throw new Error("OW_RELAY_URL must not carry credentials.");
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** One relay socket for one node offer. Reconnects with backoff and jitter until stopped. */
function relayLink(node, url, onClaim) {
  let ws = null, up = false, stopped = false, failures = 0, retryTimer = null, pinger = null;
  let lastPong = 0, lastRing = 0, busy = false;
  const sendRaw = (text) => {
    if (!up || !ws) return false;
    try { ws.send(text); return true; } catch { return false; }
  };
  const send = (message) => sendRaw(JSON.stringify({ v: 1, ...message }));
  const retry = (slow) => {
    up = false;
    clearInterval(pinger);
    ws = null;
    if (stopped) return;
    failures += 1;
    // Relay switched off at the desk (503), or this key refused: try again in minutes, not seconds.
    const cap = slow ? 300000 : Math.min(60000, 1000 * 2 ** Math.min(failures, 6));
    retryTimer = setTimeout(connect, Math.floor(cap / 2 + Math.random() * (cap / 2)));
  };
  async function connect() {
    if (stopped) return;
    let ticket = null;
    try {
      const res = await fetch(`${pool}/api/v1/relay/ticket`, { method: "POST", headers: { authorization: `Bearer ${node.secret}` }, signal: AbortSignal.timeout(10000) });
      if (!res.ok) return retry(res.status !== 429 && res.status < 500 || res.status === 503);
      const json = await res.json();
      if (typeof json.ticket === "string" && /^[A-Za-z0-9_-]{43}$/.test(json.ticket)) ticket = json.ticket;
    } catch { return retry(false); }
    if (!ticket || stopped) return retry(true);
    let socket;
    // The ticket rides in Sec-WebSocket-Protocol, never in the URL.
    try { socket = new WebSocket(`${url}?model=${encodeURIComponent(node.model)}`, [RELAY_PROTOCOL, `owt-ticket.${ticket}`]); }
    catch { return retry(false); }
    ws = socket;
    let openedAt = 0;
    socket.onopen = () => {
      if (socket.protocol !== RELAY_PROTOCOL) { try { socket.close(4001, "protocol"); } catch { /* closing */ } return; }
      openedAt = Date.now();
    };
    socket.onmessage = (event) => {
      const data = event.data;
      if (openedAt && data === RELAY_PONG) { lastPong = Date.now(); return; }
      if (openedAt && data === RELAY_READY && !up) {
        up = true;
        lastPong = Date.now();
        send({ t: "state", busy });
        pinger = setInterval(() => {
          if (Date.now() - lastPong > 60000) { try { socket.close(4002, "silent"); } catch { /* closing */ } return; }
          sendRaw(RELAY_PING);
        }, 25000);
        return;
      }
      if (up && data === RELAY_CLAIM) {
        if (Date.now() - lastRing < RING_FLOOR_MS) return;
        lastRing = Date.now();
        onClaim(node);
        return;
      }
      // Unknown, malformed, binary, or carrying any field at all: not this protocol.
      try { socket.close(4008, "malformed"); } catch { /* closing */ }
    };
    // Node's WebSocket fires only `error` when a connection attempt fails, and
    // `error` then `close` when an open socket breaks: handle whichever comes first, once.
    let lost = false;
    const gone = () => {
      if (lost || ws !== socket) return;
      lost = true;
      if (openedAt && Date.now() - openedAt > 60000) failures = 0;
      retry(false);
    };
    socket.onerror = gone;
    socket.onclose = gone;
  }
  void connect();
  return {
    get up() { return up; },
    state(next) { busy = next; send({ t: "state", busy }); },
    delta(job, seq, text) { return send({ t: "delta", job, seq, text }); },
    end(job) { send({ t: "end", job }); },
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      clearInterval(pinger);
      up = false;
      try { ws?.close(1000, "bye"); } catch { /* closed */ }
    },
  };
}

/**
 * Reads the local engine's OpenAI-style SSE and forwards text to the relay in
 * batches (every ~250 ms or 32 chunks, at most 4,000 characters a message and
 * 8,000 a job — what finishJob keeps). Returns the whole output and usage for
 * jobs/finish. The text itself is never logged.
 */
async function readEngineStream(res, link, job, prompt) {
  const decoder = new TextDecoder();
  let buffered = "", output = "", pending = "", pendingChunks = 0, chunks = 0, seq = 0, sent = 0, usage = null;
  const flush = () => {
    while (pending && sent < 8000) {
      const text = pending.slice(0, Math.min(4000, 8000 - sent));
      pending = pending.slice(text.length);
      link.delta(job.id, seq++, text);
      sent += text.length;
    }
    pending = "";
    pendingChunks = 0;
  };
  const ticker = setInterval(flush, 250);
  try {
    for await (const part of res.body) {
      buffered += decoder.decode(part, { stream: true });
      let newline;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let json;
        try { json = JSON.parse(data); } catch { continue; }
        if (json.usage) usage = json.usage;
        const text = json.choices?.[0]?.delta?.content;
        if (typeof text === "string" && text) {
          output += text;
          pending += text;
          pendingChunks += 1;
          chunks += 1;
          if (pendingChunks >= 32) flush();
        }
      }
    }
    flush();
  } finally {
    clearInterval(ticker);
  }
  // Engines that ignore stream_options.include_usage: one streamed chunk is
  // about one token, a prompt about four characters a token. The desk caps
  // both (completion at half the kept output, prompt at its length) anyway.
  return { output, usage: usage ?? { prompt_tokens: Math.ceil(String(prompt).length / 4), completion_tokens: chunks } };
}

async function pulse(node, report, tok, busy, inventory) {
  try {
    await fetch(`${pool}/api/v1/pulse`, {
      method: "POST",
      headers: { authorization: `Bearer ${node.secret}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        chip: report.chip,
        vram_gb: report.vram_gb,
        vram_used_gb: report.vram_used_gb,
        tok_per_s: tok,
        busy,
        slots,
        models: inventory,
        enc_pubkey: encKeypair().publicKey,
      }),
    });
  } catch (err) {
    console.error(`pulse ${node.model} ${err instanceof Error ? err.message : err}`);
  }
}

async function failJob(node, jobId) {
  try {
    await fetch(`${pool}/api/v1/jobs/fail`, {
      method: "POST",
      headers: { authorization: `Bearer ${node.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ id: jobId }),
    });
  } catch (err) {
    console.error(`fail-report ${jobId} ${err instanceof Error ? err.message : err}`);
  }
}

async function runJob(node, job, link = null) {
  // Stream from the engine only with a live relay socket, and never an
  // endpoint check: everything else is byte-for-byte the non-relay request.
  const streaming = Boolean(link?.up) && typeof job.id === "string" && job.id.startsWith("job_");
  try {
    await runJobOnce(node, job, streaming ? link : null);
  } finally {
    if (streaming) link.end(job.id);
  }
}

async function runJobOnce(node, job, link) {
  const streaming = link !== null;
  // Sealed jobs arrive with an empty `prompt` and an `enc` envelope instead
  // (docs/PRIVACY-ARCHITECTURE.md). A decrypt failure is never retried with
  // the same inputs — report it like any other failed job.
  let prompt = job.prompt;
  if (job.prompt_mode === "sealed" && job.enc) {
    try {
      const keys = encKeypair();
      prompt = unsealPrompt(job.enc.envelope, job.enc, job.id, nodeId(node.secret), keys.secretKey, keys.publicKey);
    } catch (err) {
      await failJob(node, job.id);
      console.error(`unseal ${job.model} ${err instanceof Error ? err.message : err}`);
      status(`failed  ${job.model}`);
      return;
    }
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 80_000);
  let res;
  try {
    res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers,
      signal: ctrl.signal,
      body: JSON.stringify({
        model: job.model,
        messages: [{ role: "user", content: prompt }],
        ...(job.id.startsWith("check_") ? { max_tokens: 512, temperature: 0 } : {}),
        stream: streaming,
        ...(streaming ? { stream_options: { include_usage: true } } : {}),
      }),
    });
  } catch (err) {
    clearTimeout(timer);
    await failJob(node, job.id);
    console.error(`fail ${job.model} ${err instanceof Error ? err.message : err}`);
    return;
  } finally {
    // A streamed body is read under the same 80 s limit.
    if (!streaming) clearTimeout(timer);
  }
  if (!res.ok) {
    clearTimeout(timer);
    await failJob(node, job.id);
    console.error(`fail ${job.model} ${res.status}`);
    status(`failed  ${job.model}`);
    return;
  }
  try {
    let output, usage;
    if (streaming && (res.headers.get("content-type") || "").includes("text/event-stream")) {
      try { ({ output, usage } = await readEngineStream(res, link, job, prompt)); }
      finally { clearTimeout(timer); }
    } else {
      // An engine that ignored `stream: true` answers with plain JSON.
      const json = await res.json();
      clearTimeout(timer);
      output = json.choices?.[0]?.message?.content ?? "";
      usage = json.usage;
    }
    await fetch(`${pool}/api/v1/jobs/finish`, {
      method: "POST",
      headers: { authorization: `Bearer ${node.secret}`, "content-type": "application/json" },
      body: JSON.stringify({
        id: job.id,
        output,
        prompt_tokens: usage?.prompt_tokens ?? 0,
        completion_tokens: usage?.completion_tokens ?? 0,
      }),
    });
  } catch (err) {
    // The finish never landed — the job is still running. Report it failed
    // (failJob is crash-safe) instead of leaving it for the stale sweep.
    await failJob(node, job.id);
    console.error(`finish ${job.model} ${err instanceof Error ? err.message : err}`);
    status(`failed  ${job.model}`);
    return;
  }
  status(`done    ${job.model}`);
}

async function serve() {
  if (!load().length) throw new Error("Nothing joined. Run: ow join");
  if (runningPid()) throw new Error("This worker is already running. Use the existing terminal.");
  modelPrices();
  const relayUrl = relayOn ? relayEndpoint() : null;
  if (relayUrl && typeof WebSocket !== "function") console.error("OW_RELAY needs Node 22 or newer (built-in WebSocket). Polling instead.");
  hold();
  // Relay sockets by node secret, and the nodes a ring asked to claim, oldest first.
  const links = new Map();
  const rung = [];
  let wakeLoop = () => {};
  // Verification suites queue their next check when the previous one
  // finishes, and the desk does not ring for checks. With a relay socket up
  // the loop polls only every 10 s, so look again for this node at once.
  const nextStep = (node, job) => {
    if (links.get(node.secret)?.up && String(job.id).startsWith("check_")) onRing(node);
  };
  const onRing = (node) => {
    if (!rung.includes(node.secret)) rung.push(node.secret);
    wakeLoop();
  };
  const syncLinks = () => {
    if (!relayUrl || typeof WebSocket !== "function") return;
    for (const node of nodes) {
      if (links.has(node.secret)) continue;
      const link = relayLink(node, relayUrl, onRing);
      link.state(Boolean(relayBusy)); // sent once the socket is ready
      links.set(node.secret, link);
    }
    for (const [secret, link] of links) if (!nodes.some(node => node.secret === secret)) { link.stop(); links.delete(secret); }
  };
  let nodes = [];
  let report = {};
  let working = false;
  const inflight = new Set();
  const speeds = new Map(), checks = new Map(), probed = new Map();
  let scanned = 0, cursor = 0, lastClaim = 0;
  const relayAllUp = () => Boolean(relayUrl) && nodes.length > 0 && nodes.every(node => links.get(node.secret)?.up);
  // Heartbeats go out when something changed (busy/free, the model list) or
  // every 30 s otherwise. The desk counts a host online for 3 minutes after
  // its last word, and every job claim refreshes that too, so a pulse on every
  // 2-second loop only spent requests.
  let lastBeat = 0, lastBusy = null, lastModels = "";
  let relayBusy = null;
  const beat = () => {
    const busy = working || inflight.size >= slots || Boolean(report.full);
    // The relay rings only idle sockets. Costs no database write.
    if (busy !== relayBusy) { relayBusy = busy; for (const link of links.values()) link.state(busy); }
    const models = nodes.map(n => n.model).join(",");
    if (busy === lastBusy && models === lastModels && Date.now() - lastBeat < 30000) return Promise.resolve();
    lastBeat = Date.now(); lastBusy = busy; lastModels = models;
    return Promise.all(nodes.map(node => pulse(node, report, speeds.get(node.model) ?? null, busy, nodes.map(n => n.model))));
  };
  // Keep all selected offers visible while one model occupies this worker.
  const heartbeat = setInterval(() => { void beat(); }, 15000);
  try {
    for (;;) {
      let pause = 2000;
      if (Date.now() - scanned >= 60000) {
        scanned = Date.now();
        try {
          const found = await models({strict:false});
          const previous = nodes;
          // Retain every key; only the currently exposed, selected models serve.
          nodes = load().filter(node => found.includes(node.model));
          for (const removed of previous.filter(node => !found.includes(node.model))) await pulse(removed, report, null, true, found);
          if (found.length) nodes = await joinPool({quiet:true,found});
          syncLinks();
          status(`1 computer · ${nodes.length} selected model${nodes.length === 1 ? "" : "s"}`);
        } catch (error) {
          console.error(`model refresh: ${error.message}`);
        }
      }
      report = await gpu();
      if (!nodes.length || report.full) {
        await beat();
        status(nodes.length ? "busy    GPU is full" : "waiting for selected models");
      } else if (inflight.size >= slots) {
        status(`working ${inflight.size}/${slots}`);
      } else {
        // A relay ring names the model to claim for; otherwise round-robin.
        const ringSecret = rung.shift();
        const node = (ringSecret && nodes.find(n => n.secret === ringSecret)) || nodes[cursor++ % nodes.length];
        // Time and test one model at a time, immediately before its turn.
        if (Date.now() >= (probed.get(node.model) ?? 0)) {
          working = true;
          await beat();
          try { const tok = await probe(node.model); if (tok) speeds.set(node.model,tok); }
          catch (error) { console.error(`probe ${node.model}: ${error.message}`); }
          finally { working = false; probed.set(node.model,Date.now()+300000); }
        }
        await beat();
        if (Date.now() >= (checks.get(node.secret) ?? 0)) {
          checks.set(node.secret,Date.now()+60000);
          try {
            const res = await fetch(`${pool}/api/v1/node/check`, {method:"POST",headers:{authorization:`Bearer ${node.secret}`},signal:AbortSignal.timeout(10000)});
            if (res.ok) checks.set(node.secret,Date.now()+12*60*60*1000);
          } catch { /* Retry without interrupting the other models. */ }
        }
        // Several models share one loop, so only a one-model host may hold.
        const link = links.get(node.secret) ?? null;
        const held = wait > 0 && nodes.length === 1 && !link?.up;
        // Never more than one claim per 200 ms, however often the relay rings.
        if (Date.now() - lastClaim < 200) await new Promise(resolve => setTimeout(resolve, 200 - (Date.now() - lastClaim)));
        lastClaim = Date.now();
        const asked = Date.now();
        try {
          const claim = await fetch(`${pool}/api/v1/jobs/claim`, {method:"POST",headers:{authorization:`Bearer ${node.secret}`,...(held ? {"x-ow-wait":String(wait)} : {})},signal:AbortSignal.timeout(held ? wait*1000+15000 : 10000)});
          if (claim.status === 204) pause = held ? Math.max(0, 2000 - (Date.now() - asked)) : relayAllUp() ? RELAY_SAFETY_POLL_MS : 2000;
          if (claim.status !== 204 && claim.ok) {
            if (held) pause = 0;
            const job = await claim.json();
            if (slots === 1) {
              working = true; await beat();
              status(`working ${job.model}`);
              try { await runJob(node,job,link); } finally { working=false; await beat(); nextStep(node,job); }
            } else {
              // Several slots: run in the background and keep claiming until
              // every slot is taken. runJob reports its own failures.
              const running = runJob(node,job,link).catch(() => {}).finally(() => { inflight.delete(running); void beat(); nextStep(node,job); });
              inflight.add(running);
              status(`working ${inflight.size}/${slots}`);
              if (inflight.size >= slots) await beat();
              else continue;
            }
          } else status(inflight.size ? `working ${inflight.size}/${slots}` : "waiting");
        } catch (error) { console.error(`claim ${error.message}`); }
      }
      if (rung.length) pause = Math.min(pause, 200);
      // A relay ring cuts the wait short.
      await new Promise(resolve => { const timer = setTimeout(resolve,pause); wakeLoop = () => { clearTimeout(timer); resolve(); }; });
      wakeLoop = () => {};
    }
  } finally {
    clearInterval(heartbeat);
    for (const link of links.values()) link.stop();
  }
}

function paint(lines) {
  const clean = lines.map((line) => String(line));
  const width = Math.min(64, Math.max(34, ...clean.map((line) => line.length)));
  const clip = (line) => (line.length > width ? `${line.slice(0, width - 1)}…` : line.padEnd(width));
  const bar = (left, right) => `${left}${"─".repeat(width + 2)}${right}`;
  console.log(bar("┌", "┐"));
  for (const line of clean) console.log(`│ ${clip(line)} │`);
  console.log(bar("└", "┘"));
}

function status(text) {
  const line = `  ${text}`.slice(0, 72);
  if (!process.stdout.isTTY) {
    console.log(line.trim());
    return;
  }
  process.stdout.write(`\r\x1b[K${line}`);
}

function runningPid() {
  try {
    const pid = Number(readFileSync(pidPath, "utf8"));
    if (!pid || pid === process.pid) return 0;
    process.kill(pid, 0);
    return pid;
  } catch {
    return 0;
  }
}

function hold() {
  mkdirSync(home, { recursive: true });
  writeFileSync(pidPath, String(process.pid));
  const drop = () => {
    try {
      if (Number(readFileSync(pidPath, "utf8")) === process.pid) unlinkSync(pidPath);
    } catch {
      /* already gone */
    }
    if (process.stdout.isTTY) process.stdout.write("\n");
    process.exit(0);
  };
  process.once("SIGINT", drop);
  process.once("SIGTERM", drop);
}

async function look() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  try {
    const res = await fetch(`${base}/v1/models`, { headers, signal: ctrl.signal });
    if (res.status === 401) return { up: false, reason: "key" };
    if (!res.ok) return { up: false, reason: "down" };
    const json = await res.json();
    return { up: true, models: (json.data || []).map((row) => row.id).filter(Boolean) };
  } catch {
    return { up: false, reason: "down" };
  } finally {
    clearTimeout(timer);
  }
}

function codes(nodes) {
  return nodes.filter((row) => row.code).flatMap((row) => [row.model, `Public node code: ${row.code}`, ""]);
}

async function go() {
  const seen = await look();
  const saved = load();
  if (!seen.up) {
    if (seen.reason === "key") {
      paint(["OpenWeights", "", "LiteLLM is running,", "but the password was refused.", "", "Set LITELLM_KEY, then run ow again."]);
      process.exitCode = 1;
      return;
    }
    paint(
      saved.length
        ? ["OpenWeights", "", "Already on this computer.", "LiteLLM is not running right now.", "", ...codes(saved), "Start LiteLLM, then run ow again."]
        : ["OpenWeights", "", "LiteLLM is not running", "on this computer.", "", "Start it, then run ow again."],
    );
    process.exitCode = 1;
    return;
  }
  if (!seen.models.length) {
    paint(["OpenWeights", "", "LiteLLM is running.", "It has no models loaded.", "", "Load one, then run ow again."]);
    process.exitCode = 1;
    return;
  }
  const joined = await joinPool({ quiet: true });
  const open = runningPid();
  paint([
    "OpenWeights",
    "",
    "LiteLLM is running.",
    `${seen.models.length} model${seen.models.length === 1 ? "" : "s"} on this computer.`,
    "",
    ...codes(joined),
    open ? "Already open in another window." : "Leave this window open.",
    "Run ow status to confirm the pool test passed.",
    "Run ow link for a one-time account pairing code.",
    "Endpoint tests renew every 12h while serving.",
  ]);
  if (open) return;
  await serve();
}

const cmd = process.argv[2];
try {
  if (cmd === "models") { for (const model of await models()) console.log(model); }
  else if (cmd === "status" || cmd === "link") {
    const nodes = load().filter(node => !selection.length || selection.includes(node.model));
    if (!nodes.length) throw new Error("Run ow join first.");
    for (const node of nodes) {
      const res = await fetch(`${pool}/api/v1/node/${cmd === "link" ? "link" : "status"}`, {
        method: cmd === "link" ? "POST" : "GET", headers: { authorization: `Bearer ${node.secret}` }, signal: AbortSignal.timeout(15000),
      });
      const result = await res.json();
      if (!res.ok) { console.error(`${node.model}: ${result.error || `HTTP ${res.status}`}`); process.exitCode = 1; continue; }
      console.log(node.model);
      if (cmd === "link") console.log(`One-time code: ${result.code}\nExpires: ${result.expiresAt}\nEnter at ${pool}/account/machines\n`);
      else console.log(`${result.state.toUpperCase()} · Pool test: ${result.check || "not run"}\nLast worker contact: ${result.lastSeen}\n`);
    }
  }
  else if (!cmd) await go();
  else if (cmd === "join") await joinPool();
  else if (cmd === "serve") await serve();
  else if (cmd === "check") {
    const nodes = load();
    if (!nodes.length) throw new Error("Run ow join first");
    for (const node of nodes) {
      const res = await fetch(`${pool}/api/v1/node/check`, {
        method: process.argv[3] === "status" ? "GET" : "POST",
        headers: { authorization: `Bearer ${node.secret}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`check ${node.model}: HTTP ${res.status}`);
      console.log(node.model, await res.json());
    }
    console.log("Keep ow serve running to execute the check. Read results: ow check status. This tests the endpoint, not the weights.");
  }
  else {
    console.log("ow models  list the local server’s models without joining");
    console.log("ow status  read pool readiness without renewing the heartbeat");
    console.log("ow link    get a one-time account pairing code");
    console.log("ow        look at this computer, then stay open");
    console.log("ow join   register the models, then stop");
    console.log("ow serve  stay open, if already registered");
    console.log("ow check [status]  request or read a pool endpoint test");
    console.log("OW_SLOTS=4 ow serve   take up to 4 jobs at once (engines that batch, like vLLM)");
    console.log("OW_RELAY=1 ow serve   instant jobs and streamed replies over one outbound connection (no open ports)");
    process.exit(1);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
