// CRS812 diagnostic policy. A fan-control boundary is attention, not a component failure limit.
export const HEALTH_LEVELS = ['normal', 'warning', 'abnormal', 'unknown'];
export const HEALTH_CODES = ['supplies-ok','supply-failed','supply-idle','supply-unknown',
  'fans-ok','fan-failed','fan-stopped','fan-unknown','temperatures-in-control-range',
  'temperature-at-full-fan','cpu-overtemperature','temperature-unknown','not-current'];
export const LEVEL_LABELS = { normal: '異常なし（取得範囲）', warning: '注意', abnormal: '異常', unknown: '未確認' };
export const sensorName = /^(?:[a-z0-9-]*temperature\d*|fan-state|fan\d*-speed|psu[12]-(?:state|voltage|input-voltage|current|power|fan-speed)|voltage|current|power-consumption)$/;
export const STATE_VALUES = ['ok','fail','failed','idle','no-input','not-present'];
const severity = { normal: 0, unknown: 1, warning: 2, abnormal: 3 };
const item = (level, code) => ({ level, code });
export function assessHealth(sensors, settings = null) {
  const values = new Map(sensors.map(s => [s.name, s]));
  const powerStates = ['psu1-state','psu2-state'].map(n => values.get(n)?.value);
  const power = powerStates.some(v => ['fail','failed','no-input','not-present'].includes(v))
    ? item('abnormal','supply-failed') : powerStates.includes('idle') ? item('warning','supply-idle')
      : powerStates.every(v => v === 'ok') ? item('normal','supplies-ok') : item('unknown','supply-unknown');
  const fanState = values.get('fan-state')?.value;
  const rpms = ['fan1-speed','fan2-speed','fan3-speed','fan4-speed','psu1-fan-speed','psu2-fan-speed']
    .map(n => values.get(n)).map(s => s?.unit === 'RPM' && Number.isFinite(s.value) ? s.value : null);
  const cooling = ['fail','failed'].includes(fanState) ? item('abnormal','fan-failed')
    : rpms.some(v => v === 0) ? item('warning','fan-stopped')
      : fanState === 'ok' && rpms.every(v => v !== null && v > 0) ? item('normal','fans-ok') : item('unknown','fan-unknown');
  const temps = ['cpu-temperature','switch-temperature','phy-temperature','board-temperature1',
    'board-temperature2','board-temperature3','psu1-temperature','psu2-temperature'].map(n => values.get(n));
  const cpu = values.get('cpu-temperature');
  const controlTemps = temps.slice(0,6);
  const valid = s => s?.unit === 'C' && Number.isFinite(s.value);
  const settingValid = settings && settings.cpuOvertempCheck === true && Number.isFinite(settings.cpuOvertempThreshold)
    && Number.isFinite(settings.fanFullSpeedTemp) && Number.isFinite(settings.fanTargetTemp)
    && settings.fanFullSpeedTemp > settings.fanTargetTemp && settings.cpuOvertempThreshold > settings.fanFullSpeedTemp;
  const temperature = settingValid && valid(cpu) && cpu.value >= settings.cpuOvertempThreshold
    ? item('abnormal','cpu-overtemperature')
    : settingValid && controlTemps.some(s => valid(s) && s.value >= settings.fanFullSpeedTemp)
      ? item('warning','temperature-at-full-fan')
      : settingValid && temps.every(valid) ? item('normal','temperatures-in-control-range') : item('unknown','temperature-unknown');
  const overall = [power,cooling,temperature].reduce((a,b) => severity[b.level] > severity[a] ? b.level : a, 'normal');
  return { policy: 'crs812-health-v1', overall, power, cooling, temperature };
}
export function unknownHealth() {
  return { policy: 'crs812-health-v1', overall: 'unknown', power: item('unknown','not-current'),
    cooling: item('unknown','not-current'), temperature: item('unknown','not-current') };
}
export function reasonText(code, settings) {
  return {
    'supplies-ok': '電源1・2とも機器がokと報告しています。',
    'supply-failed': '故障・入力電源なし・電源未装着の値があります。2系統の正常を確認できません。',
    'supply-idle': '待機中の電源があります。故障とは別ですが、2系統の稼働は確認できません。',
    'supply-unknown': '電源2系統の状態がそろっていません。',
    'fans-ok': '機器のfan-stateはokで、筐体4台と電源2台のファンが回転しています。',
    'fan-failed': '機器がファン異常と報告しています。',
    'fan-stopped': '回転数0のファンがあります。停止理由を確認してください。',
    'fan-unknown': 'ファン状態または6台の回転数を確認できません。',
    'temperatures-in-control-range': `内部の制御対象温度は全速設定${settings?.fanFullSpeedTemp ?? '—'}℃未満、CPUは過熱保護${settings?.cpuOvertempThreshold ?? '—'}℃未満です。`,
    'temperature-at-full-fan': `制御対象の温度がファン全速設定${settings?.fanFullSpeedTemp ?? '—'}℃以上です。故障の断定ではなく冷却状況の確認が必要です。`,
    'cpu-overtemperature': `CPUが実機の過熱保護設定${settings?.cpuOvertempThreshold ?? '—'}℃以上です。`,
    'temperature-unknown': '温度または実機の制御設定を確認できません。',
    'not-current': '現在の測定値を取得できません。',
  }[code] ?? '判定できません。';
}
