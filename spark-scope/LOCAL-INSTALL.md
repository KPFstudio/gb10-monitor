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

## CRS812 read-only monitoring and judgments (2026-10-12)

The existing Scope page adds a CRS812 power/cooling section. `/api/switch` is the
single source for the Scope page and Internal Home's summary. It reads RouterOS
`/system health print terse without-paging` every 30 seconds and
`/system health settings print` every five minutes, over an existing
SSH alias, with batch mode and strict host-key verification. No RouterOS setting,
account, fan control, route, interface or power state is changed. Raw device logs
are not collected (they may contain private data); sampled health history is
stored outside git at `~/.local/share/spark-scope/switch-history.json`, mode 0600,
bounded to 1,440 samples / 12 hours. The screen displays the last 20 observations.

Connection configuration is local-only at
`~/.config/spark-scope/switch.local.json` (or `SPARK_SCOPE_SWITCH_CONFIG`), containing
only `{"sshHost":"crs812"}`. Authentication and transport settings belong
in the operator's existing SSH configuration; do not put passwords in this JSON.
Do not create device users, accept unverified host keys, or enable SSH automatically.

The operator provisioned `crs812mon` with an SSH key and a dedicated group allowing
only `read,ssh`. The alias uses DGX1 as ProxyJump to the existing management address;
no reset or high-speed network change was needed. Credentials remain outside this
repository. The collector itself never provisions users or changes their policies.

`public/switch-health.js` is the single diagnostic policy. It consumes the 21 actual
sensor readings and validated live control settings. PSU `ok` means reported normal;
`fail`, legacy `failed`, `no-input` and `not-present` are abnormal; `idle` is attention;
missing or unrecognized states remain unknown. Cooling requires `fan-state=ok` and
positive RPM for all four chassis and both PSU fans. A stopped fan needs attention;
an explicit fan failure is abnormal. Temperatures reaching the fan full-speed setting
(currently 65 C, target 58 C) need attention, without calling that a component failure
limit. CPU reaching its enabled overtemperature protection (currently 115 C) is abnormal.
The ambient specification is never used as an internal-temperature limit. PSU-specific
temperature limits and the rear LED colors remain unconfirmed and are displayed as such.

The overall label is "no abnormality in observed scope", attention, abnormal or unknown,
with separate power/cooling/temperature judgments, reasons, settings, readings and time.
Internal Home consumes a sanitized projection through its `/api/crs812` endpoint and
links back to this view; it does not duplicate the diagnostic thresholds. After
connection loss, current values clear while historical records retain their original
timestamps; readings older than 90 seconds are stale. Persistent-write failure is
shown separately. This implementation does not establish the cause of the reported
fan-noise incident, for which no contemporaneous telemetry was captured.

Verification: 150 Spark Scope tests, 19 Internal Home tests and seven focused API/security
tests passed. The actual browser showed both live views. Ten browser-only mocked cases
covered normal, PSU failure/input loss/idle, fan failure, temperature rise/overtemperature,
missing readings, acquisition failure and stale data without changing the device.
