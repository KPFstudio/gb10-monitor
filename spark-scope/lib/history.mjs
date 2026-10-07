// The in-memory chart history: what /api/state sends for the selected range, and the active output average.
// Thermal samples follow the gb10-monitor (port 8910) contract: every five-second node poll adds at most one
// representative sample (the maximum over all ACPI thermal zones) and per-sensor readings; means are arithmetic
// over the inclusive window; missing or offline polls produce no sample. The GPU temperature is never averaged
// into the thermal statistic (it stays its own series).

export const HISTORY_FIELDS = ["outputTokensPerSecond", "promptTokensPerSecond", "runningRequests", "queue"];
export const HISTORY_NODE_FIELDS = ["temperature", "memoryAvailableBytes"];
// Per node: one representative max-over-zones series plus individually keyed sensors (ACPI zone suffixes, nvme, nic).
export const HISTORY_NODE_THERMAL_FIELDS = ["thermal"];

const ONE_MINUTE_MS = 60 * 1000;
const FIVE_MINUTE_MS = 5 * 60 * 1000;
const FIFTEEN_MINUTE_MS = 15 * 60 * 1000;
const round1 = (value) => Math.round(value * 10) / 10;

const mean = (values) => {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
};

// At most targetCount points: consecutive samples are averaged into one point stamped with the last one's time.
// Missing values are left out of an average, and a bucket with none stays null so the chart line breaks.
export function downsampleHistory(points, targetCount = 360) {
  if (points.length <= targetCount) return points;
  const bucketSize = Math.ceil(points.length / targetCount);
  const output = [];
  for (let index = 0; index < points.length; index += bucketSize) {
    const bucket = points.slice(index, index + bucketSize);
    const last = bucket.at(-1);
    const averaged = { ...last };
    for (const key of HISTORY_FIELDS) averaged[key] = mean(bucket.map((point) => point[key]));
    averaged.nodes = Object.fromEntries(Object.keys(last.nodes ?? {}).map((id) => [id, downsampleNode(bucket, id)]));
    output.push(averaged);
  }
  return output;
}

function downsampleNode(bucket, id) {
  const samples = bucket.map((point) => point.nodes?.[id]).filter(Boolean);
  const averaged = Object.fromEntries(HISTORY_NODE_FIELDS.map((field) => [field, mean(samples.map((sample) => sample[field]))]));
  for (const field of HISTORY_NODE_THERMAL_FIELDS) averaged[field] = mean(samples.map((sample) => sample[field]));
  const sensorNames = [...new Set(samples.flatMap((sample) => Object.keys(sample.sensors ?? {})))].sort();
  if (sensorNames.length) {
    // A sensor absent from every finite sample of the bucket is left out entirely instead of becoming a
    // meaningless entry, so an empty gap stays a gap in the chart.
    averaged.sensors = Object.fromEntries(sensorNames
      .map((name) => [name, mean(samples.map((sample) => sample.sensors?.[name]))])
      .filter(([, value]) => Number.isFinite(value)));
    if (!Object.keys(averaged.sensors).length) delete averaged.sensors;
  }
  return averaged;
}

// The mean output rate over the samples with requests running (idle periods would pull it towards zero).
export function summarizeHistory(points, minutes = 60) {
  const activeOutputRates = points
    .filter((point) => point.runningRequests > 0 && Number.isFinite(point.outputTokensPerSecond))
    .map((point) => point.outputTokensPerSecond);
  return {
    activeOutputTokensPerSecond: activeOutputRates.length
      ? activeOutputRates.reduce((sum, value) => sum + value, 0) / activeOutputRates.length
      : null,
    activeSamples: activeOutputRates.length,
    windowMinutes: minutes,
  };
}

// Canonical thermal stats for one series of { at, value } samples: arithmetic mean over the inclusive last
// 1m, 5m and 15m windows (one decimal) and the maximum over the last 5m (one decimal). A window without
// samples stays null, so offline or missing sensors read as unknown rather than as a zero.
function canonicalStats(samples, now) {
  const inWindow = (ms) => samples.filter((sample) => now - sample.at <= ms);
  const mean1m = mean(inWindow(ONE_MINUTE_MS).map((sample) => sample.value));
  const mean5m = mean(inWindow(FIVE_MINUTE_MS).map((sample) => sample.value));
  const windowSamples = samples.filter((sample) => now - sample.at <= FIFTEEN_MINUTE_MS);
  const mean15m = mean(windowSamples.map((sample) => sample.value));
  const last5m = inWindow(FIVE_MINUTE_MS);
  // Age span between the oldest and newest available sample in the 15m window, capped to 15m: the warm-up
  // indicator for how much of the window has actually been observed (null with no samples, 0 with one).
  const ats = windowSamples.map((sample) => sample.at);
  const coverageMs = windowSamples.length
    ? Math.min(Math.max(...ats) - Math.min(...ats), FIFTEEN_MINUTE_MS)
    : null;
  return {
    mean1m: mean1m === null ? null : round1(mean1m),
    mean5m: mean5m === null ? null : round1(mean5m),
    mean15m: mean15m === null ? null : round1(mean15m),
    max5m: last5m.length ? round1(Math.max(...last5m.map((sample) => sample.value))) : null,
    // Sample count over the retained 15m window: the warm-up indicator while history is still filling.
    samples: windowSamples.length,
    coverageMs,
  };
}

// Per-node thermal statistics over the full-resolution five-second history, shaped for /api/state:
// { [nodeId]: { representative: {…}, sensors: { [name]: {…} } } }. Nodes without thermal samples are left out.
export function summarizeThermal(points, now = Date.now()) {
  const perNode = new Map();
  for (const point of points ?? []) {
    for (const [id, node] of Object.entries(point.nodes ?? {})) {
      if (!node) continue;
      let entry = perNode.get(id);
      if (!entry) { entry = { representative: [], sensors: new Map() }; perNode.set(id, entry); }
      if (Number.isFinite(node.thermal)) entry.representative.push({ at: point.at, value: node.thermal });
      for (const [name, value] of Object.entries(node.sensors ?? {})) {
        if (!Number.isFinite(value)) continue;
        if (!entry.sensors.has(name)) entry.sensors.set(name, []);
        entry.sensors.get(name).push({ at: point.at, value });
      }
    }
  }
  const output = {};
  for (const [id, { representative, sensors }] of perNode) {
    const node = {};
    if (representative.length) node.representative = canonicalStats(representative, now);
    if (sensors.size) {
      node.sensors = Object.fromEntries([...sensors.entries()]
        .filter(([, samples]) => samples.length)
        .map(([name, samples]) => [name, canonicalStats(samples, now)]));
    }
    if (node.representative || node.sensors) output[id] = node;
  }
  return output;
}
