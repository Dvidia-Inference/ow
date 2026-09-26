#!/usr/bin/env node
// OW CLI. Sits next to LiteLLM, tells the desk what the GPU can do, then takes a job.

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const pool = (process.env.POOL_URL || "https://owterminal.com").replace(/\/$/, "");
const base = (process.env.LITELLM_BASE || "http://127.0.0.1:4000").replace(/\/$/, "");
const key = process.env.LITELLM_KEY || "";
const price = Number(process.env.OW_PRICE || 100);
const home = process.env.OW_HOME || join(homedir(), ".ow");
const statePath = join(home, "nodes.json");
const pidPath = join(home, "serve.pid");
const headers = {
  "content-type": "application/json",
  ...(key ? { authorization: `Bearer ${key}` } : {}),
};

function load() {
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
    return Array.isArray(parsed.nodes) ? parsed.nodes : [];
  } catch {
    return [];
  }
}

function save(nodes) {
  mkdirSync(home, { recursive: true });
  writeFileSync(statePath, JSON.stringify({ nodes }, null, 2));
}

async function models() {
  const res = await fetch(`${base}/v1/models`, { headers });
  if (res.status === 401) throw new Error("LiteLLM wants LITELLM_KEY");
  if (!res.ok) throw new Error(`models ${res.status}`);
  const json = await res.json();
  return (json.data || []).map((row) => row.id).filter(Boolean);
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
    return { chip: null, vram_gb: null, vram_used_gb: null, full: false };
  }
}

async function probe(model) {
  const started = Date.now();
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers,
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

async function joinPool({ quiet = false } = {}) {
  const found = await models();
  if (!found.length) throw new Error("LiteLLM has no models loaded");
  const nodes = load();
  for (const model of found) {
    const already = nodes.find((row) => row.model === model);
    if (already) {
      if (!quiet && already.code) console.log(`${model} already on. Your code is ${already.code}`);
      continue;
    }
    const res = await fetch(`${pool}/api/v1/node`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, price }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.secret) throw new Error(json.error || `join ${model} ${res.status}`);
    nodes.push({ model, secret: json.secret, code: json.code });
    if (!quiet) {
      console.log(model);
      console.log(`Your code is ${json.code}`);
      console.log("Type it on https://owterminal.com/pool");
    }
  }
  save(nodes);
  return nodes.filter((row) => found.includes(row.model));
}

async function pulse(node, report, tok, busy) {
  await fetch(`${pool}/api/v1/pulse`, {
    method: "POST",
    headers: { authorization: `Bearer ${node.secret}`, "content-type": "application/json" },
    body: JSON.stringify({
      chip: report.chip,
      vram_gb: report.vram_gb,
      vram_used_gb: report.vram_used_gb,
      tok_per_s: tok,
      busy,
      models: load().map((row) => row.model),
    }),
  });
}

async function runJob(node, job) {
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
        messages: [{ role: "user", content: job.prompt }],
        stream: false,
      }),
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    await fetch(`${pool}/api/v1/jobs/fail`, {
      method: "POST",
      headers: { authorization: `Bearer ${node.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ id: job.id }),
    });
    console.error(`fail ${job.model} ${res.status}`);
    status(`failed  ${job.model}`);
    return;
  }
  const json = await res.json();
  await fetch(`${pool}/api/v1/jobs/finish`, {
    method: "POST",
    headers: { authorization: `Bearer ${node.secret}`, "content-type": "application/json" },
    body: JSON.stringify({
      id: job.id,
      output: json.choices?.[0]?.message?.content ?? "",
      prompt_tokens: json.usage?.prompt_tokens ?? 0,
      completion_tokens: json.usage?.completion_tokens ?? 0,
    }),
  });
  status(`done    ${job.model}`);
}

async function serve() {
  const nodes = load();
  if (!nodes.length) throw new Error("Nothing joined. Run: ow");
  hold();
  const speeds = new Map();
  let probed = 0;
  let cursor = 0;
  for (;;) {
    const report = await gpu();
    const now = Date.now();
    if (now - probed > 60_000) {
      status("timing");
      for (const node of nodes) {
        if (report.full) break;
        const tok = await probe(node.model);
        if (tok) speeds.set(node.model, tok);
      }
      probed = Date.now();
    }
    for (const node of nodes) {
      await pulse(node, report, speeds.get(node.model) ?? null, report.full);
    }
    if (report.full) {
      status("busy    GPU is full");
    } else {
      const node = nodes[cursor % nodes.length];
      cursor += 1;
      const claim = await fetch(`${pool}/api/v1/jobs/claim`, {
        method: "POST",
        headers: { authorization: `Bearer ${node.secret}` },
      });
      if (claim.status !== 204 && claim.ok) {
        const job = await claim.json();
        status(`working ${job.model}`);
        await pulse(node, report, speeds.get(node.model) ?? null, true);
        await runJob(node, job);
        continue;
      }
      status("waiting");
    }
    await new Promise((r) => setTimeout(r, 2000));
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
  return nodes.filter((row) => row.code).flatMap((row) => [row.model, `Your code is ${row.code}`, ""]);
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
    "Type the code on owterminal.com/pool",
  ]);
  if (open) return;
  await serve();
}

const cmd = process.argv[2];
try {
  if (!cmd) await go();
  else if (cmd === "join") await joinPool();
  else if (cmd === "serve") await serve();
  else {
    console.log("ow        look at this computer, then stay open");
    console.log("ow join   register the models, then stop");
    console.log("ow serve  stay open, if already registered");
    process.exit(1);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
