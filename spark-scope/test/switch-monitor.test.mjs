import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseHealth, classifySensors, validateSwitchConfig, publicSwitch, SwitchMonitor, HEALTH_COMMAND } from '../lib/switch-monitor.mjs';
const sample = '0 name=cpu-temperature value=42 type=C\n1 name=fan1-speed value=4500 type=RPM\n2 name=psu1-state value=ok\n3 name=psu2-state value=failed\n4 name=password value=secret\n';
test('health readings are allowlisted and explicit failure is preserved', () => {
  const sensors = parseHealth(sample);
  assert.equal(sensors.length, 4);
  assert.equal(sensors[0].value, 42);
  assert.equal(parseHealth('name=fan2-speed value=6000 type=rpm')[0].unit, 'RPM');
  assert.equal(classifySensors(sensors), 'power-warning');
  assert.equal(classifySensors(parseHealth('name=temperature value=40 type=C')), 'partial');
  assert.equal(classifySensors(parseHealth('name=psu1-state value=ok\nname=psu2-state value=ok')), 'observed');
});
test('unknowns are not numeric zero or healthy; malformed output fails closed', () => {
  assert.equal(parseHealth('name=fan1-speed value=n/a type=RPM')[0].value, null);
  assert.equal(parseHealth('name=psu2-state value=unrecognized')[0].value, null);
  assert.throws(() => parseHealth('permission denied'));
});
test('only a plain SSH alias is configured; credentials and injected options are rejected', () => {
  assert.deepEqual(validateSwitchConfig({ sshHost: 'crs812-monitor' }), { sshHost: 'crs812-monitor' });
  for (const c of [{ sshHost: '-oProxyCommand=evil' }, { sshHost: 'host;touch file' }, { sshHost: 'user@host' },
    { sshHost: 'host', password: 'secret' }, { sshHost: 'host', command: 'reboot' }]) assert.throws(() => validateSwitchConfig(c));
});
test('stale live readings clear but historical samples retain original timestamps', () => {
  const s = { ok: true, status: 'observed', observedAt: '2026-10-10T00:00:00Z', sensors: [{ value: 40 }], history: [] };
  assert.equal(publicSwitch(s, Date.parse(s.observedAt) + 90_001).status, 'stale');
  assert.deepEqual(publicSwitch(s, Date.parse(s.observedAt) + 90_001).sensors, []);
});
test('collector reads only, persists sanitized data, and clears current readings on loss', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'crs812-test-'));
  try {
    const configPath = path.join(dir, 'config.json'), historyPath = path.join(dir, 'history.json');
    await writeFile(configPath, JSON.stringify({ sshHost: 'crs812-monitor' }));
    let failed = false;
    const monitor = new SwitchMonitor({ configPath, historyPath, execute: async (cmd, args, opts) => {
      assert.equal(cmd, 'ssh'); assert.equal(args.at(-1), HEALTH_COMMAND);
      assert.ok(args.includes('StrictHostKeyChecking=yes')); assert.ok(opts.timeout <= 8_000);
      if (failed) throw new Error('secret-user@private-address');
      return { stdout: sample };
    } });
    await monitor.collect();
    assert.equal(monitor.view().status, 'power-warning');
    const saved = await readFile(historyPath, 'utf8');
    assert.ok(!saved.includes('secret'));
    failed = true; await monitor.collect();
    assert.equal(monitor.view().status, 'connection-failed');
    assert.deepEqual(monitor.view().sensors, []);
    assert.equal(monitor.view().history.length, 1);
    assert.ok(!JSON.stringify(monitor.view()).includes('private-address'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('missing configuration does not attempt any login', async () => {
  const monitor = new SwitchMonitor({ configPath: '/missing-crs-config', historyPath: '/missing-crs-history',
    execute: async () => { assert.fail('must not log in'); } });
  await monitor.collect(); assert.equal(monitor.view().status, 'not-configured');
});
