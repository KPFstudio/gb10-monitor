# Local installation

This is the pinned Spark Scope instance managed alongside the existing GB10
Monitor. Upstream details are in `UPSTREAM.md`.

- The local LaunchAgent runs Node from `/Users/yourname/.local/bin/node`.
- The app binds only to `127.0.0.1:8914`.
- Its vLLM endpoint is the existing loopback SSH forward at
  `http://127.0.0.1:8093`; no additional SSH key or forward is used.
- `topology.local.json` uses the existing `dgx1`–`dgx4` SSH aliases and collects the
  four machines independently.
- The topology intentionally has no cable links. A live read on 2026-10-02
  showed `enp1s0f0np0` carrier up on all four machines and `enp1s0f1np1`
  carrier down on all four; address assignments also differ from the older
  ring profile. Do not draw a ring until the active cabling is independently
  confirmed.
- Tailscale Serve is configured separately and remains tailnet-only at
  `https://your-mac.your-tailnet.ts.net:8914/`.

The usage ledger uses Spark Scope's default per-user path under
`~/.local/share/spark-scope/usage.sqlite`.
