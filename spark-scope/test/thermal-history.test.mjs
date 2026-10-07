import test from "node:test";
import assert from "node:assert/strict";
import { buildThermalPoint, thermalNodeSample, pruneThermalPoints, ThermalHistory } from "../lib/thermal-history.mjs";
import { summarizeThermal } from "../lib/history.mjs";

const onlineNode = (zones, extra = {}) => ({ ok: true, thermals: { zones }, ...extra });
const offlineNode = () => ({ ok: false, error: "SSH connection failed" });

test("the representative sample is the maximum over the ACPI zones; nvme and nic are keyed individually", () => {
  const sample = thermalNodeSample(onlineNode({ TSOC: 41.5, TS1P: 44.25 }, { gpu: { temperature: 88 }, nvmeCelsius: 38, nicCelsius: 40 }));
  assert.equal(sample.thermal, 44.25);
  assert.deepEqual(sample.sensors, { TSOC: 41.5, TS1P: 44.25, nvme: 38, nic: 40 });
  assert.equal(JSON.stringify(sample).includes("88"), false, "the GPU temperature stays out of the thermal sample");
});

test("offline and missing readings are not synthesized into samples", () => {
  const offline = thermalNodeSample(offlineNode());
  assert.equal(offline.thermal, null);
  assert.deepEqual(offline.sensors, {});
  const noReading = thermalNodeSample(onlineNode({}, { nvmeCelsius: null }));
  assert.equal(noReading.thermal, null);
  assert.equal("nvme" in noReading.sensors, false, "a null nvme reading is not turned into a sample");
});

test("exactly one thermal point per node poll, not one per inference poll", () => {
  const thermal = new ThermalHistory({ windowMs: 6 * 60 * 60 * 1000, limit: 4400 });
  const inferenceHistory = [];
  // 10 node polls every 5 s; in between, 25 inference polls every 2 s each add a chart history point.
  for (let poll = 0; poll < 10; poll += 1) {
    for (let api = 0; api < 5; api += 1) {
      inferenceHistory.push({ at: poll * 5000 + api * 2000 });
    }
    thermal.addFromNodes(
      { nodeA: onlineNode({ TSOC: 40 + poll }), nodeB: offlineNode() },
      poll * 5000,
    );
  }
  assert.equal(thermal.points.length, 10, "one point per node poll");
  assert.equal(inferenceHistory.length, 50, "the inference cadence stays its own");
  assert.deepEqual(thermal.points.map((point) => point.at), Array.from({ length: 10 }, (_, i) => i * 5000));
  assert.deepEqual(thermal.points.map((point) => point.nodes.nodeB.thermal), Array.from({ length: 10 }, () => null));
});

test("thermal stats come from the thermal history, at one sample per node poll", () => {
  const now = 20_000;
  const thermal = new ThermalHistory({ windowMs: 6 * 60 * 60 * 1000, limit: 4400 });
  for (let poll = 0; poll < 5; poll += 1) {
    thermal.addFromNodes({ nodeA: onlineNode({ TSOC: 40 + poll }, { nvmeCelsius: 30 + poll }) }, (poll + 1) * 5000);
  }
  const stats = summarizeThermal(thermal.points, now);
  assert.equal(stats.nodeA.representative.samples, 5, "sample count follows the 5 s node polls");
  assert.equal(stats.nodeA.representative.mean15m, 42);
  assert.equal(stats.nodeA.sensors.nvme.mean15m, 32);
});

test("the thermal history prunes to the window and the safe limit", () => {
  const thermal = new ThermalHistory({ windowMs: 60_000, limit: 8 });
  for (let poll = 0; poll < 30; poll += 1) thermal.addFromNodes({ nodeA: onlineNode({ TSOC: 40 }) }, poll * 5000);
  assert.equal(thermal.points.length, 8);
  assert.ok(thermal.points[0].at >= 22 * 5000, "points older than the window are dropped");
  assert.deepEqual(pruneThermalPoints([{ at: 0 }, { at: 90_000 }], 60_000, 100, 90_000).map((p) => p.at), [90_000]);
});

test("nodes missing from a poll are simply absent from that point", () => {
  const point = buildThermalPoint({ nodeA: onlineNode({ TSOC: 42 }) }, 1000);
  assert.equal(point.at, 1000);
  assert.deepEqual(Object.keys(point.nodes), ["nodeA"]);
  assert.equal(point.nodes.nodeA.thermal, 42);
});
