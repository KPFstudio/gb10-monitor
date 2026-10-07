import test from "node:test";
import assert from "node:assert/strict";
import { downsampleHistory, summarizeHistory, summarizeThermal } from "../lib/history.mjs";

const point = (at, output, running, temperature) => ({
  at, outputTokensPerSecond: output, promptTokensPerSecond: null, runningRequests: running, queue: 0,
  nodes: { 1: { temperature, memoryAvailableBytes: null } },
});

test("a long history is averaged down to at most the target count, keeping gaps as gaps", () => {
  const points = Array.from({ length: 10 }, (_, i) => point(i * 1000, i < 4 ? 10 * (i + 1) : null, 1, i < 2 ? null : 50 + i));
  assert.equal(downsampleHistory(points, 20), points);
  const down = downsampleHistory(points, 5);
  assert.equal(down.length, 5);
  // Each point stands for two samples and carries the later one's time.
  assert.deepEqual(down.map((p) => p.at), [1000, 3000, 5000, 7000, 9000]);
  assert.deepEqual(down.map((p) => p.outputTokensPerSecond), [15, 35, null, null, null]);
  assert.deepEqual(down.map((p) => p.nodes[1].temperature), [null, 52.5, 54.5, 56.5, 58.5]);
  assert.equal(down[0].nodes[1].memoryAvailableBytes, null);
});

test("the active average counts only samples with requests running", () => {
  const stats = summarizeHistory([point(0, 0, 0, 40), point(1, 60, 2, 41), point(2, 80, 1, 42), point(3, null, 1, 43)], 15);
  assert.deepEqual(stats, { activeOutputTokensPerSecond: 70, activeSamples: 2, windowMinutes: 15 });
  assert.equal(summarizeHistory([point(0, 0, 0, 40)]).activeOutputTokensPerSecond, null);
});

// One node's five-second thermal samples: the representative value is the maximum over the ACPI zones of that
// poll; nvme and nic are keyed individually. The GPU temperature never enters the thermal statistic.
const thermalPoint = (at, { thermal = null, sensors = {}, temperature = null } = {}) => ({
  at, outputTokensPerSecond: null, runningRequests: null, queue: 0,
  nodes: { 1: { temperature, memoryAvailableBytes: null, thermal, sensors } },
});

test("thermal downsampling averages the representative series and each sensor of a bucket", () => {
  const points = [
    thermalPoint(0, { thermal: 40, sensors: { TSOC: 40, nvme: 38 } }),
    thermalPoint(1000, { thermal: 44, sensors: { TSOC: 44, TS1P: 42 } }),
  ];
  const down = downsampleHistory(points, 20);
  assert.equal(down, points, "short histories pass through untouched");
  const [bucket] = downsampleHistory([...points, ...Array.from({ length: 400 }, (_, i) => thermalPoint(2000 + i * 1000, { thermal: 50 }))], 360);
  assert.equal(bucket.nodes[1].thermal, 42);
  assert.equal(bucket.nodes[1].sensors.TSOC, 42);
  assert.equal(bucket.nodes[1].sensors.TS1P, 42);
  assert.equal(bucket.nodes[1].sensors.nvme, 38, "a sensor absent from some samples is averaged over the ones that have it");
});

test("thermal stats follow the canonical contract: max over zones per poll, inclusive window means, 5m max", () => {
  const now = 15 * 60_000;
  const samples = (offsets, value) => thermalPoints(offsets.map((o) => now - o), value);
  const thermalPoints = (ats, value) => ats.map((at) => thermalPoint(at, { thermal: value, sensors: { TSOC: value } }));
  // 61 s, 10 m, 20 m old, plus a current sample: the inclusive windows take them all in.
  const points = [
    ...samples([20 * 60_000], 30),
    ...samples([10 * 60_000], 40),
    ...samples([61_000], 50),
    ...samples([0], 60),
  ];
  const stats = summarizeThermal(points, now);
  // Mean over the inclusive last 15m window (60, 50 and 40), rounded to one decimal.
  assert.equal(stats[1].representative.mean15m, 50);
  assert.equal(stats[1].representative.mean5m, 55);
  assert.equal(stats[1].representative.mean1m, 60);
  assert.equal(stats[1].representative.max5m, 60);
  assert.equal(stats[1].representative.samples, 3);
  // Coverage: the age span between the oldest (10m) and newest (now) sample inside the 15m window.
  assert.equal(stats[1].representative.coverageMs, 10 * 60_000);
  assert.equal(stats[1].sensors.TSOC.coverageMs, 10 * 60_000, "each sensor gets the same canonical treatment");
  assert.equal(stats[1].sensors.TSOC.mean15m, 50, "each sensor gets the same canonical treatment");
  assert.deepEqual(summarizeThermal([thermalPoint(now, { thermal: null })], now), {}, "no sample is no statistic");
});

test("coverageMs spans the observed part of the 15m window and is capped at 15 minutes", () => {
  const now = 60 * 60_000;
  const points = (offsets) => offsets.map((o) => thermalPoint(now - o, { thermal: 40, sensors: { TSOC: 40 } }));
  // One sample only: coverage is zero seconds.
  let stats = summarizeThermal(points([0]), now);
  assert.equal(stats[1].representative.coverageMs, 0);
  assert.equal(stats[1].representative.samples, 1);
  // Samples exactly 15m apart: the cap keeps the span at 15 minutes.
  stats = summarizeThermal(points([15 * 60_000, 0]), now);
  assert.equal(stats[1].representative.coverageMs, 15 * 60_000);
  // Samples older than 15m are excluded, so they never extend the span beyond the cap.
  stats = summarizeThermal(points([30 * 60_000, 10 * 60_000, 0]), now);
  assert.equal(stats[1].representative.coverageMs, 10 * 60_000);
  assert.equal(stats[1].representative.samples, 2);
  // A series with no sample in the window has no coverage at all (it would be no statistic anyway).
  stats = summarizeThermal(points([30 * 60_000]), now);
  assert.equal(stats[1].representative.coverageMs, null);
});

test("offline and missing sensors produce no thermal sample, and the GPU temperature is never mixed in", () => {
  const now = 60_000;
  const points = [
    { at: now, outputTokensPerSecond: null, runningRequests: null, queue: 0, nodes: { 1: { temperature: 90, memoryAvailableBytes: null, thermal: null, sensors: { TSOC: 41 } } } },
    { at: now - 1000, outputTokensPerSecond: null, runningRequests: null, queue: 0, nodes: { 2: { temperature: 88, memoryAvailableBytes: null, thermal: 55, sensors: { nvme: 44 } } } },
  ];
  const stats = summarizeThermal(points, now);
  assert.equal(stats[1].representative, undefined, "the node without a representative sample has no representative series");
  assert.equal(stats[1].sensors.TSOC.mean1m, 41);
  assert.equal(stats[2].representative.mean1m, 55);
  assert.equal(JSON.stringify(stats).includes("90"), false, "the GPU temperature stays out of the thermal statistic");
});
