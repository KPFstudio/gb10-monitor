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

## CRS812 read-only monitoring (2026-10-10)

The existing Scope page adds a CRS812 power/cooling section. `/api/switch` is the
single source for the Scope page and Internal Home's summary. It reads RouterOS
`/system health print terse without-paging` every 30 seconds, over an existing
SSH alias, with batch mode and strict host-key verification. No RouterOS setting,
account, fan control, route, interface or power state is changed. Raw device logs
are not collected (they may contain private data); sampled health history is
stored outside git at `~/.local/share/spark-scope/switch-history.json`, mode 0600,
bounded to 1,440 samples / 12 hours. The screen displays the last 20 observations.

Connection configuration is local-only at
`~/.config/spark-scope/switch.local.json` (or `SPARK_SCOPE_SWITCH_CONFIG`), containing
only `{"sshHost":"crs812-monitor"}`. Authentication and transport settings belong
in the operator's existing SSH configuration; do not put passwords in this JSON.
Do not create device users, accept unverified host keys, or enable SSH automatically.

Until that connection exists, the display says preparation pending and all health
values are unknown. Missing PSU values are not healthy. Explicit PSU `failed`
raises a power warning; no guessed fan/temperature limits are applied. After
connection loss, current values clear while historical records retain their original
timestamps; readings older than 90 seconds are stale. Persistent-write failure is
shown separately. This implementation does not establish the cause of the reported
fan-noise incident, for which no contemporaneous telemetry was captured.
