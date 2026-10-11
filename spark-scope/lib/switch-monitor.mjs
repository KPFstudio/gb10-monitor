// RouterOS reads only. SSH credentials remain in the operator's existing SSH config.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { sensorName, STATE_VALUES, assessHealth, unknownHealth } from '../public/switch-health.js';
const exec = promisify(execFile);
export const HEALTH_COMMAND = '/system health print terse without-paging';
export const SETTINGS_COMMAND = '/system health settings print';
export function parseSettings(text) {
  const get = key => String(text).match(new RegExp('(?:^|\\s)' + key + ':\\s*(\\S+)'))?.[1];
  const number = key => { const s = get(key); return /^\d+(?:\.\d+)?(?:C|%)?$/.test(s ?? '') ? Number(s.replace(/[C%]$/, '')) : null; };
  return { fanTargetTemp: number('fan-target-temp'), fanFullSpeedTemp: number('fan-full-speed-temp'),
    fanMinSpeedPercent: number('fan-min-speed-percent'), cpuOvertempThreshold: number('cpu-overtemp-threshold'),
    cpuOvertempCheck: get('cpu-overtemp-check') === 'yes' ? true : get('cpu-overtemp-check') === 'no' ? false : null };
}
export const SWITCH_INTERVAL_MS = 30_000;
export const SWITCH_STALE_MS = 90_000;
const LIMIT = 1440; // 12 hours at a 30-second cadence, also bounded by time.

export function parseHealth(text) {
  const sensors = [];
  for (const line of String(text).split(/\r?\n/)) {
    const fields = Object.fromEntries([...line.matchAll(/(?:^|\s)(name|value|type)=("[^"]*"|[^\s]+)/g)]
      .map(([, key, value]) => [key, value.replace(/^"|"$/g, '')]));
    if (!sensorName.test(fields.name ?? '')) continue;
    const units = { c: 'C', rpm: 'RPM', v: 'V', a: 'A', w: 'W', ma: 'mA' };
    const unit = units[fields.type?.toLowerCase()] ?? '';
    if (fields.name.endsWith('-state')) {
      const value = fields.value?.toLowerCase();
      sensors.push({ name: fields.name, value: STATE_VALUES.includes(value) ? value : null, unit: '' });
    } else {
      const value = /^[+-]?\d+(?:\.\d+)?$/.test(fields.value ?? '') ? Number(fields.value) : null;
      sensors.push({ name: fields.name, value: Number.isFinite(value) ? value : null,
        unit: ['C', 'RPM', 'V', 'A', 'W', 'mA'].includes(unit) ? unit : '' });
    }
  }
  if (!sensors.length) throw new Error('health-unavailable');
  return sensors;
}

export function classifySensors(sensors) {
  const states = ['psu1-state', 'psu2-state'].map(name => sensors.find(s => s.name === name)?.value ?? null);
  if (states.some(value => ['fail', 'failed', 'no-input', 'not-present'].includes(value))) return 'power-warning';
  // Missing PSU telemetry never becomes "both supplies healthy".
  return states.every(value => value === 'ok') ? 'observed' : 'partial';
}

export function validateSwitchConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => key !== 'sshHost')
    || typeof value.sshHost !== 'string'
    || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value.sshHost)) {
    throw new Error('config-invalid');
  }
  return { sshHost: value.sshHost };
}

export function publicSwitch(snapshot, now = Date.now()) {
  const fresh = snapshot.ok && Number.isFinite(Date.parse(snapshot.observedAt))
    && now >= Date.parse(snapshot.observedAt)
    && now - Date.parse(snapshot.observedAt) <= SWITCH_STALE_MS;
  return { ...snapshot, ok: Boolean(fresh),
    status: snapshot.ok && !fresh ? 'stale' : snapshot.status,
    sensors: fresh ? snapshot.sensors : [], health: fresh ? snapshot.health ?? unknownHealth() : unknownHealth(),
    settings: fresh ? snapshot.settings ?? null : null };
}

export class SwitchMonitor {
  constructor({ configPath, historyPath, execute = exec, now = Date.now } = {}) {
    this.configPath = configPath;
    this.historyPath = historyPath;
    this.execute = execute;
    this.now = now;
    this.running = false;
    this.history = [];
    this.loaded = false;
    this.settings = null; this.settingsAt = 0;
    this.snapshot = { label: 'CRS812', ok: false, status: 'not-configured', sensors: [],
      observedAt: null, attemptedAt: null, historyStored: false, history: [] };
  }
  async loadHistory() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const data = JSON.parse(await readFile(this.historyPath, 'utf8'));
      // Strictly project persisted values again; never publish arbitrary disk contents.
      this.history = Array.isArray(data) ? data.slice(-LIMIT).filter(p =>
        p && Number.isFinite(Date.parse(p.at)) && Array.isArray(p.sensors)).map(p => ({
          at: p.at, status: ['observed', 'partial', 'power-warning'].includes(p.status) ? p.status : 'partial',
          sensors: p.sensors.filter(s => sensorName.test(s?.name ?? '')).map(s => ({
            name: s.name, value: Number.isFinite(s.value) || STATE_VALUES.includes(s.value) ? s.value : null,
            unit: ['C', 'RPM', 'V', 'A', 'W', 'mA', ''].includes(s.unit) ? s.unit : '' })) })) : [];
    } catch { this.history = []; }
  }
  view() { return publicSwitch(this.snapshot, this.now()); }
  async collect() {
    if (this.running) return;
    this.running = true;
    const attemptedAt = new Date(this.now()).toISOString();
    try {
      await this.loadHistory();
      this.history = this.history.filter(p => Date.parse(p.at) >= this.now() - 12 * 60 * 60_000
        && Date.parse(p.at) <= this.now()).slice(-LIMIT);
      let config;
      try { config = validateSwitchConfig(JSON.parse(await readFile(this.configPath, 'utf8'))); }
      catch (error) { throw new Error(error.code === 'ENOENT' ? 'not-configured' : 'config-invalid'); }
      const { stdout } = await this.execute('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', 'ConnectTimeout=5', '-o', 'ConnectionAttempts=1', config.sshHost, HEALTH_COMMAND],
      { timeout: 8_000, maxBuffer: 64 * 1024, encoding: 'utf8' });
      const sensors = parseHealth(stdout);
      if (this.now() - this.settingsAt >= 300_000 || !this.settingsAt) {
        try {
          const result = await this.execute('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
            '-o', 'ConnectTimeout=5', '-o', 'ConnectionAttempts=1', config.sshHost, SETTINGS_COMMAND],
            { timeout: 8_000, maxBuffer: 16 * 1024, encoding: 'utf8' });
          this.settings = parseSettings(result.stdout); this.settingsAt = this.now();
        } catch { this.settings = null; this.settingsAt = 0; }
      }
      const health = assessHealth(sensors, this.settings);
      const observedAt = new Date(this.now()).toISOString();
      const status = classifySensors(sensors);
      this.history.push({ at: observedAt, status, sensors });
      this.history = this.history.filter(p => Date.parse(p.at) >= this.now() - 12 * 60 * 60_000).slice(-LIMIT);
      let historyStored = false;
      try {
        await mkdir(path.dirname(this.historyPath), { recursive: true, mode: 0o700 });
        await writeFile(`${this.historyPath}.tmp`, JSON.stringify(this.history), { mode: 0o600 });
        await rename(`${this.historyPath}.tmp`, this.historyPath);
        historyStored = true;
      } catch { /* Readings remain usable; storage failure is explicit. */ }
      this.snapshot = { label: 'CRS812', ok: true, status, sensors, health, settings: this.settings, observedAt, attemptedAt,
        historyStored, history: this.history };
    } catch (error) {
      const status = ['not-configured', 'config-invalid', 'health-unavailable'].includes(error.message)
        ? error.message : 'connection-failed';
      this.snapshot = { label: 'CRS812', ok: false, status, sensors: [],
        observedAt: this.snapshot.observedAt, attemptedAt, historyStored: this.snapshot.historyStored,
        history: this.history };
    } finally { this.running = false; }
  }
}
