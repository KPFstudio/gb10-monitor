import { escapeHtml as esc } from './view-data.js';
import { LEVEL_LABELS, reasonText, unknownHealth } from './switch-health.js';
export const SWITCH_LABELS = {
  'not-configured': '管理接続の準備待ち', 'config-invalid': '接続設定を確認してください',
  'connection-failed': '管理接続に届かない', 'health-unavailable': '機器の状態を取得できない',
  'stale': '測定が古い', 'observed': '電源2系統の正常値を取得',
  'partial': '一部取得・電源2系統は未確認', 'power-warning': '電源状態に異常あり',
};
const time = at => Number.isFinite(Date.parse(at)) ? new Date(at).toLocaleString('ja-JP') : '未取得';
export function switchPanelHtml(snapshot, now = Date.now()) {
  const s = snapshot ?? {};
  const age = now - Date.parse(s.observedAt);
  const live = s.ok && Number.isFinite(age) && age >= 0 && age <= 90_000;
  const status = s.ok && !live ? 'stale' : s.status;
  const sensors = live && Array.isArray(s.sensors) ? s.sensors : [];
  const reading = sensor => sensor.value == null ? '未取得' : `${esc(sensor.value)} ${esc(sensor.unit ?? '')}`;
  const health = live ? s.health ?? unknownHealth() : unknownHealth();
  const judgment = ['power', 'cooling', 'temperature'].map((key, i) => {
    const part = health[key]; return `<p><strong>${['電源', '冷却', '温度'][i]}：${esc(LEVEL_LABELS[part?.level] ?? '未確認')}</strong><br>${esc(reasonText(part?.code, s.settings))}</p>`;
  }).join('');
  const rows = sensors.map(sensor => `<tr><th scope="row">${esc(sensor.name)}</th><td>${reading(sensor)}</td></tr>`).join('');
  const history = Array.isArray(s.history) ? s.history.slice(-20).reverse() : [];
  return `<header><h2>CRS812 | 電源と冷却</h2><strong>${esc(LEVEL_LABELS[health.overall] ?? '未確認')}</strong></header>
    <p>${esc(SWITCH_LABELS[status] ?? '未取得')}</p>${judgment}
    <p>状態取得：${esc(time(s.observedAt))} ／ 接続確認：${esc(time(s.attemptedAt))}</p>
    ${rows ? `<div class="switch-table"><table><thead><tr><th>センサー</th><th>現在値</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p>電源1・電源2 ／ 内部温度 ／ ファン回転数：<strong>未取得</strong></p>'}
    <p class="note">PSU＝電源ユニット。機器の診断と実機の制御設定に基づく判定です。ファン全速温度は故障の境界ではありません。電源温度の固有上限と背面ランプの色の意味は未確認です。値がない項目は正常とは判定しません。</p>
    <p class="note">30秒ごとに読み取り。90秒以上前の値は現在値として使いません。記録保存：${s.historyStored ? '保存済み（最大12時間）' : '未保存'}。</p>
    <details><summary>電源・冷却の記録（直近20回／全記録は最大12時間）</summary>
      ${history.length ? `<div class="switch-table"><table><thead><tr><th>取得時刻</th><th>観測値</th></tr></thead><tbody>${history.map(p => `<tr><td>${esc(time(p.at))}</td><td>${(p.sensors ?? []).map(sensor => `${esc(sensor.name)}: ${reading(sensor)}`).join('<br>')}</td></tr>`).join('')}</tbody></table></div>` : '<p>まだ記録がありません。今回の爆音時の値は取得していません。</p>'}
    </details><p class="note">読み取り専用です。再発時は抜き差し前にPOWER1・POWER2・FAULTの表示と取得時刻を記録してください。爆音の原因やPSU故障は、この表示だけで断定しません。</p>`;
}
