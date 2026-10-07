// The in-memory thermal history: an independent series of five-second node-collection points, added exactly
// once per collectNodes() run — never at the faster inference polling rate. Each point keeps the representative
// maximum over the node's ACPI thermal zones plus the individual sensors (zone firmware suffixes, nvme, nic).
// Missing or offline polls produce no sample: nothing is synthesized. summarizeThermal() (history.mjs) reads
// this series, while the inference/GPU/memory chart history keeps its own cadence and behavior.

// Per collected node: the representative max-over-zones value of this poll plus each individually keyed sensor.
// A node that is offline, unreachable or simply has no reading contributes nothing (null representative, no
// sensors), never a made-up zero.
export function thermalNodeSample(node) {
  const ok = node?.ok;
  const zones = ok ? Object.entries(node.thermals?.zones ?? {}).filter(([, value]) => Number.isFinite(value)) : [];
  const sensorEntries = [
    ...zones,
    ["nvme", ok ? node.nvmeCelsius : null],
    ["nic", ok ? node.nicCelsius : null],
  ].filter(([, value]) => Number.isFinite(value));
  return {
    thermal: zones.length ? Math.max(...zones.map(([, value]) => value)) : null,
    sensors: Object.fromEntries(sensorEntries),
  };
}

// One thermal point from the whole node map of one node poll.
export function buildThermalPoint(nodesById, now = Date.now()) {
  return {
    at: now,
    nodes: Object.fromEntries(Object.entries(nodesById ?? {}).map(([id, node]) => [id, thermalNodeSample(node)])),
  };
}

// Keeps at most `limit` points no older than `windowMs`, trimming from the front.
export function pruneThermalPoints(points, windowMs, limit, now = Date.now()) {
  const cutoff = now - windowMs;
  while (points.length > limit || (points[0] && points[0].at < cutoff)) points.shift();
  return points;
}

export class ThermalHistory {
  constructor({ windowMs, limit }) {
    this.windowMs = windowMs;
    this.limit = limit;
    this.points = [];
  }

  // Called exactly once at the end of every node collection, after state.nodes are updated.
  addFromNodes(nodesById, now = Date.now()) {
    this.points.push(buildThermalPoint(nodesById, now));
    pruneThermalPoints(this.points, this.windowMs, this.limit, now);
    return this.points;
  }
}
