import { test } from 'node:test';
import assert from 'node:assert/strict';
import { switchPanelHtml } from '../public/switch-panel.js';
test('unconfigured view exposes no fake readings', () => {
  const html = switchPanelHtml({ status: 'not-configured' });
  assert.match(html, /管理接続の準備待ち/); assert.match(html, /未取得/);
  assert.doesNotMatch(html, /0 RPM/);
});
test('current telemetry expires, history remains dated and labels are escaped', () => {
  const s = { ok: true, status: 'observed', observedAt: '2026-10-10T00:00:00Z',
    sensors: [{ name: '<script>', value: 5678, unit: 'RPM' }], history: [] };
  assert.match(switchPanelHtml(s, Date.parse(s.observedAt)), /&lt;script&gt;/);
  assert.doesNotMatch(switchPanelHtml(s, Date.parse(s.observedAt) + 90_001), /5678/);
});
