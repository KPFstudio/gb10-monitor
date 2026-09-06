# GB10 Monitor

A tiny, zero-dependency web monitor for NVIDIA GB10 systems — DGX Spark, ThinkStation PGX, ASUS GX10, and compatible Linux hosts.

It polls each host over SSH (GPU, memory, all thermal zones, load average) and serves a single auto-refreshing dashboard built for quick glances from a phone. Lightweight by design: no Docker, no database, no Prometheus, no auth.

## Why this exists

Running GB10 systems 24/7 for LLM inference, you quickly learn that GPU temperature alone is not enough. The GPU can sit comfortably in the 70s while the **hottest thermal zone** runs past 90 °C. And an instant spike to 92 °C means something different from a 1-minute average of 92 °C.

This tool answers one question at a glance: **is the cluster actually hot, or did it just spike for a second?**

For each host it shows:

- GPU temperature / power / utilization
- Unified memory, load average
- **Hottest thermal zone** (current value plus 1-minute, 5-minute and 15-minute averages, and a 5-minute maximum)
- A small sparkline of recent thermal readings
- Which zone is hottest (`thermal_zone0 (acpitz)`, etc.) — it does not assume one zone is the SoC
- A one-glance status per host, judged by the **1-minute average, not the instant value**

Two views, switchable from the top of the page:

- **Detail** — the full per-host breakdown above
- **Summary** — a compact, mobile-friendly grid that fits **all hosts on one phone screen** (each host shows online state, status, current thermal value, the 1m/5m/15m averages and a mini sparkline)

The layout is responsive, and the dashboard is available in **English, Japanese, and Simplified Chinese** (auto-detected from the browser, switchable in the top-right). On a narrow screen it opens in the Summary view.

> It is deliberately **not** a full cluster manager. It intentionally does not try to be. If you need multi-node orchestration, LLM server metrics, benchmarks, or power control, use a dedicated tool. This one is thermal-first and SSH-only.

## Requirements

- Node.js ≥ 16 on the machine where the dashboard runs
- SSH access (with keys) from that machine to each GB10 host
- Linux on the remote hosts (`/sys/class/thermal`, `nvidia-smi`, `free`, `/proc/loadavg`)

## 1. SSH setup

Make sure you can SSH to each node non-interactively using keys:

```bash
ssh dgx1 nvidia-smi
```

If that prompts for a password, set up key-based auth first. Shortcuts, port options, and user names belong in `~/.ssh/config`, e.g.:

```
Host gb10-1
  HostName 192.168.1.50
  User ubuntu
  IdentityFile ~/.ssh/id_ed25519
```

## 2. Configure hosts

```bash
cp config.example.json config.json
```

Edit `config.json`:

```json
{
  "port": 8910,
  "pollMs": 5000,
  "sshTimeoutMs": 8000,
  "hosts": [
    { "ssh": "gb10-1", "label": "GB10 node 1" },
    { "ssh": "gb10-2", "label": "GB10 node 2" }
  ],
  "thresholds": {
    "gpuWarn": 75,
    "gpuHot": 85,
    "socNote": 85,
    "socWarn": 90,
    "socHot": 93,
    "peak": 95
  }
}
```

- `hosts[].ssh` is the SSH alias / host from step 1.
- `port`, `pollMs`, `sshTimeoutMs` are optional. `PORT` env var overrides `port`.

## 3. Run

```bash
node server.js        # or: npm start
```

## 4. Open the dashboard

```
http://127.0.0.1:8910/
```

The page auto-refreshes. To view it from your phone, use Tailscale Serve (or any TLS reverse proxy) so it is reachable on your tailnet:

```bash
tailscale serve --bg --https=8910 http://127.0.0.1:8910
```

## Thresholds

There are only four states per host, judged by the **1-minute average** of the hottest thermal zone:

| 1-min average of hottest zone | State |
|---|---|
| `< socNote` | Normal |
| `>= socNote` | Caution |
| `>= socWarn` | High |
| `>= socHot` | Action |

A **peak warning** appears when the 5-minute max reaches `>= peak`.

**These thresholds are operational heuristics, not NVIDIA / Lenovo / ASUS thermal limits.** They are tuned for early awareness on 24/7 inference boxes, not for vendor warranty or safety boundaries. Adjust them in `config.json` to fit your setup.

## Positioning

Compared to full cluster-management tooling, this project intentionally keeps its scope narrow:

- SSH is the only transport — no agents on the hosts
- Zero runtime dependencies (Node.js core only)
- One screen, phone-first
- Thermal monitoring first, everything else second

## License

MIT — see [LICENSE](LICENSE).
