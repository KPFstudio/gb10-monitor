import test from 'node:test';
import assert from 'node:assert/strict';
import { assessHealth } from '../public/switch-health.js';
import { parseHealth, parseSettings, publicSwitch } from '../lib/switch-monitor.mjs';
const text = `name=cpu-temperature value=51 type=C
name=switch-temperature value=58 type=C
name=phy-temperature value=33 type=C
name=board-temperature1 value=36 type=C
name=board-temperature2 value=40 type=C
name=board-temperature3 value=36 type=C
name=psu1-temperature value=31 type=C
name=psu2-temperature value=32 type=C
name=fan-state value=ok
name=fan1-speed value=2790 type=RPM
name=fan2-speed value=2910 type=RPM
name=fan3-speed value=2910 type=RPM
name=fan4-speed value=2820 type=RPM
name=psu1-fan-speed value=3884 type=RPM
name=psu2-fan-speed value=4008 type=RPM
name=psu1-state value=ok
name=psu2-state value=ok
name=psu1-input-voltage value=101.7 type=V`;
const settings = parseSettings('fan-full-speed-temp: 65C\nfan-target-temp: 58C\nfan-min-speed-percent: 12%\ncpu-overtemp-check: yes\ncpu-overtemp-threshold: 115C');
test('actual CRS812 fixture includes board/PSU sensors and target fan temperature is not a fault', () => {
  const sensors = parseHealth(text);
  assert.equal(sensors.length, 18);
  assert.equal(assessHealth(sensors, settings).overall, 'normal');
  assert.equal(assessHealth(sensors, settings).temperature.code, 'temperatures-in-control-range');
  assert.equal(assessHealth(sensors, parseSettings('permission denied')).temperature.level, 'unknown');
});
test('both official and legacy failure words, absent power, idle, cooling failure and unknowns stay distinct', () => {
  for (const state of ['fail','failed','no-input','not-present']) {
    assert.equal(assessHealth(parseHealth(text.replace('psu2-state value=ok', `psu2-state value=${state}`)), settings).power.level, 'abnormal');
  }
  assert.equal(assessHealth(parseHealth(text.replace('psu2-state value=ok','psu2-state value=idle')), settings).power.level, 'warning');
  assert.equal(assessHealth(parseHealth(text.replace('psu2-state value=ok','psu2-state value=unknown')), settings).power.level, 'unknown');
  assert.equal(assessHealth(parseHealth(text.replace('fan-state value=ok','fan-state value=fail')), settings).cooling.level, 'abnormal');
  assert.equal(assessHealth(parseHealth(text.replace('fan2-speed value=2910','fan2-speed value=0')), settings).cooling.level, 'warning');
});
test('full-speed control temperature needs attention; CPU protection is abnormal; missing values and stale snapshots cannot be normal', () => {
  assert.equal(assessHealth(parseHealth(text.replace('switch-temperature value=58','switch-temperature value=65')), settings).temperature.level, 'warning');
  assert.equal(assessHealth(parseHealth(text.replace('cpu-temperature value=51','cpu-temperature value=115')), settings).temperature.level, 'abnormal');
  assert.equal(assessHealth(parseHealth(text.replace('board-temperature2 value=40','board-temperature2 value=n/a')), settings).temperature.level, 'unknown');
  const at = '2026-10-12T00:00:00Z';
  assert.equal(publicSwitch({ok:true, observedAt:at, sensors:parseHealth(text), health:assessHealth(parseHealth(text),settings)}, Date.parse(at)+90001).health.overall, 'unknown');
});
