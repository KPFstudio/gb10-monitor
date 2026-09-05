#!/usr/bin/env node
// gb10-monitor — a tiny, zero-dependency web monitor for NVIDIA GB10 systems.
// It polls each host over SSH (nvidia-smi, memory, thermal zones, load average)
// and serves a single-page dashboard that auto-refreshes.
//
// Config: config.json (gitignored) or config.example.json as a template.
//   PORT is overridable via the PORT environment variable.
"use strict";
const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const CONFIG_REAL = path.join(__dirname, "config.json");
const CONFIG_EXAMPLE = path.join(__dirname, "config.example.json");

function loadConfig() {
  const file = fs.existsSync(CONFIG_REAL) ? CONFIG_REAL : CONFIG_EXAMPLE;
  if (!fs.existsSync(file)) {
    console.error("[gb10-monitor] No config.json or config.example.json found.");
    process.exit(1);
  }
  if (file === CONFIG_EXAMPLE) {
    console.log("[gb10-monitor] config.json not found; using config.example.json. Copy it to config.json and edit hosts.");
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const config = loadConfig();
const DEFAULT_THRESHOLDS = { gpuWarn: 75, gpuHot: 85, socNote: 85, socWarn: 90, socHot: 93, peak: 95 };
const thresholds = { ...DEFAULT_THRESHOLDS, ...(config.thresholds || {}) };
const PORT = process.env.PORT ? Number(process.env.PORT) : (config.port || 8910);
const POLL_MS = config.pollMs || 5000;
const SSH_TIMEOUT_MS = config.sshTimeoutMs || 8000;

const REMOTE_CMD = [
  "echo =GPU=",
  "nvidia-smi --query-gpu=temperature.gpu,power.draw,clocks.current.sm,clocks.max.sm,utilization.gpu,utilization.memory --format=csv,noheader,nounits 2>&1",
  "echo =MEM=",
  "free -b | grep '^Mem:'",
  "echo =THERMAL=",
  "for z in /sys/class/thermal/thermal_zone*; do v=\$(cat \$z/temp 2>/dev/null); [ -n \"\$v\" ] || continue; t=\$(cat \$z/type 2>/dev/null); [ -n \"\$t\" ] || t=-; echo \"\$z \$t \$v\"; done",
  "echo =LOAD=",
  "cut -d' ' -f1-3 /proc/loadavg",
].join("; ");

function sshHost(host) {
  return new Promise((resolve) => {
    const child = spawn("ssh", [
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=5",
      "-o", "ServerAliveInterval=0",
      host.ssh,
      REMOTE_CMD,
    ]);
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, SSH_TIMEOUT_MS);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(parseRemote(out));
      } else {
        resolve({ online: false, error: (err || ("exit " + code)).trim().split("\n").pop() });
      }
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ online: false, error: e.message });
    });
  });
}

function parseRemote(out) {
  const sections = {};
  let key = null;
  for (const line of out.split("\n")) {
    const m = line.match(/^=([A-Z]+)=\s*$/);
    if (m) {
      key = m[1];
      sections[key] = [];
    } else if (key && line.trim() !== "") {
      sections[key].push(line.trim());
    }
  }
  const r = { online: true };
  const gpu = (sections.GPU || [])[0];
  if (gpu && !gpu.startsWith("Failed") && !gpu.includes("ERROR")) {
    const parts = gpu.split(",").map((s) => s.trim());
    r.gpu = {
      tempC: Number(parts[0]),
      powerW: Number(parts[1]),
      smMhz: Number(parts[2]),
      smMaxMhz: Number(parts[3]),
      utilPct: Number(parts[4]),
      memUtilPct: Number(parts[5]),
    };
  } else if (gpu) {
    r.gpuError = gpu;
  }
  const mem = (sections.MEM || [])[0];
  if (mem) {
    const nums = mem.replace(/^Mem:/, "").trim().split(/\s+/).map(Number);
    if (nums[0] && nums[1] != null) r.mem = { totalBytes: nums[0], usedBytes: nums[1] };
  }
  const zoneLines = sections.THERMAL || [];
  const zones = [];
  let zoneMax = null;
  for (const line of zoneLines) {
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const zone = parts[0];
    const rawTemp = parts[parts.length - 1];
    const tempMilli = Number(rawTemp);
    if (!Number.isFinite(tempMilli)) continue;
    const typeName = parts.length >= 3 ? parts.slice(1, parts.length - 1).join(" ") : "-";
    const tempC = tempMilli / 1000;
    zones.push({ zone, type: typeName, tempC });
    if (zoneMax == null || tempC > zoneMax) zoneMax = tempC;
  }
  if (zoneMax != null) {
    r.thermalTempC = zoneMax;
    r.thermalZones = zones;
    r.hottestZone = zones.reduce((a, b) => (b.tempC > a.tempC ? b : a), zones[0]);
  }
  const load = (sections.LOAD || [])[0];
  if (load) r.loadAvg = load.split(" ").map(Number);
  return r;
}

let cache = { ts: 0, hosts: [] };
let running = null;

const HISTORY_MS = 5 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;
const histories = new Map();

async function refresh() {
  const now = Date.now();
  const results = await Promise.all(config.hosts.map((h) => sshHost(h).then((r) => ({ label: h.label, ssh: h.ssh, ...r }))));
  for (const host of results) {
    let hist = histories.get(host.label);
    if (!hist) { hist = []; histories.set(host.label, hist); }
    if (host.online && host.thermalTempC != null) hist.push({ t: now, v: host.thermalTempC });
    while (hist.length && now - hist[0].t > HISTORY_MS) hist.shift();
    const lastMin = hist.filter((p) => now - p.t <= ONE_MINUTE_MS);
    host.thermal1mAvg = lastMin.length ? Math.round((lastMin.reduce((a, p) => a + p.v, 0) / lastMin.length) * 10) / 10 : null;
    host.thermal5mMax = hist.length ? Math.round(Math.max(...hist.map((p) => p.v)) * 10) / 10 : null;
    host.thermalHistory = hist.map((p) => ({ t: p.t, v: p.v }));
  }
  cache = { ts: now, hosts: results };
  return cache;
}

function getCached() {
  if (!running && (cache.hosts.length === 0 || Date.now() - cache.ts >= POLL_MS)) {
    running = refresh().catch(() => {}).finally(() => { running = null; });
  }
  return running ? running : Promise.resolve(cache);
}

const html = () => fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/api/status") {
      await getCached();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ts: cache.ts, pollMs: POLL_MS, thresholds, hosts: cache.hosts }));
    } else if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html());
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  } catch (e) {
    res.writeHead(500);
    res.end(String(e));
  }
});
server.listen(PORT, "127.0.0.1", () => {
  console.log("gb10-monitor listening on http://127.0.0.1:" + PORT);
});
