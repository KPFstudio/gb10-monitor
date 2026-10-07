import { COLORS, nodeOrder, linkText, UNKNOWN, finite, fixed, compact, duration, tokenRate, gib, escapeHtml as esc, clockTime, eventTime, localDay, monthLabel, dayLabel, monthOptions, chartPath, validateMonth, fabricLayout, labelWidth, nextTheme, topologyKey, staleAfterMs, livePoint, mergeLivePoint, timeoutSignal, onMediaChange, PRICE_META, priceFor, priceEquivalent, priceCardKey } from './view-data.js';
import { initLanguage, setLanguage, saveLanguage, currentLanguage, t, localeName } from './i18n.js';
const $ = selector => document.querySelector(selector);
let latest = null, metas = [], lastTopology = null, range = 60, collecting = false, monthSequence = 0, monthLoadedAt = 0, monthController = null, monthUsage = null;
// The full history is fetched every 30 s and when the range changes; polls in between add their own sample to it.
const HISTORY_REFRESH_MS = 30_000;
let history = [], historyAt = 0, historyRange = null;
// The token ledger counts days in the server's time zone (usage.timeZone); until the first response, the viewer's own.
let ledgerTimeZone = null;
const ledgerToday = () => localDay(Date.now(), ledgerTimeZone);
// Until the server names its ledger time zone, the month is a guess; it follows the server's month unless picked by hand.
let selectedMonth = ledgerToday().slice(0,7), earliestMonth = null, monthPicked = false;
// Canonical per-node thermal statistics of the latest /api/state (see history.mjs).
let thermal = {};
// The localized value shown wherever a number was not observed; the plain 'unknown' stays the internal marker.
const un = () => t('value.unknown');
// Unchanged text is left alone, so live regions only speak when something actually changes.
function text(selector, value) { const shown = value === UNKNOWN ? un() : value; const el = $(selector); if (el.textContent !== shown) el.textContent = shown; el.classList.toggle('unknown-value', value === UNKNOWN || value === 'stopped'); }
function setCell(el, value) { const shown = value === UNKNOWN ? un() : value; if (el.textContent !== shown) el.textContent = shown; el.classList.toggle('unknown-value', value === UNKNOWN); }
// Theme: follows the system until picked; the button cycles through the other look, the system's look and back to system.
const themeToggle=$('#theme-toggle'),darkQuery=matchMedia('(prefers-color-scheme: dark)');
let themeChoice=null;try{const saved=localStorage.getItem('spark-scope-theme');if(saved==='light'||saved==='dark')themeChoice=saved}catch{}
function applyTheme() {
  const system=darkQuery.matches?'dark':'light',next=nextTheme(themeChoice,system);
  document.documentElement.dataset.theme=themeChoice??system;themeToggle.dataset.choice=themeChoice??'system';
  themeToggle.title=`${t('theme.title')}: ${themeChoice??`system (${system})`}`;themeToggle.setAttribute('aria-label',themeToggle.title);
}
themeToggle.addEventListener('click',()=>{themeChoice=nextTheme(themeChoice,darkQuery.matches?'dark':'light');try{themeChoice?localStorage.setItem('spark-scope-theme',themeChoice):localStorage.removeItem('spark-scope-theme')}catch{}applyTheme()});
onMediaChange(darkQuery,applyTheme);applyTheme();

// Language: saved preference first, then the browser's languages (ja reads as Japanese); the switch keeps its
// own storage key, so the theme choice survives a language change untouched.
const langToggle=$('#lang-toggle');
function applyLangButton(){langToggle.textContent=t('lang.label');langToggle.title=t('lang.switch');langToggle.setAttribute('aria-label',t('lang.switch'));}
langToggle.addEventListener('click',()=>{const next=currentLanguage()==='ja'?'en':'ja';saveLanguage(next);setLanguage(next);});
window.addEventListener('langchange',()=>{applyLangButton();applyStaticTexts();applyTheme();rebuildMonths();buildNodes();metas.forEach(meta=>renderNode(meta,latest?.nodes?.[meta.id]));if(latest)renderState(latest);renderMonthAside();renderToday(latest?.usage);});
initLanguage();applyLangButton();

// Static page text from the dictionary: [data-i18n] replaces text, -aria and -title set attributes,
// -html is reserved for dictionary strings that carry their own line break.
function applyStaticTexts() {
  document.querySelectorAll('[data-i18n]').forEach(el=>{el.textContent=t(el.dataset.i18n)});
  document.querySelectorAll('[data-i18n-html]').forEach(el=>{el.innerHTML=esc(t(el.dataset.i18nHtml)).replace('\n','<br>')});
  document.querySelectorAll('[data-i18n-aria]').forEach(el=>{el.setAttribute('aria-label',t(el.dataset.i18nAria))});
  document.querySelectorAll('[data-i18n-title]').forEach(el=>{el.title=t(el.dataset.i18nTitle);el.setAttribute('aria-label',t(el.dataset.i18nTitle))});
  $('#token-month').setAttribute('aria-label',t('aria.ledgerMonth'));
  document.title='Spark Scope';
}
function rebuildNodesStatic(){applyStaticTexts();}
// Which counters the engine exported in its latest sample (usage.reported); an unreported counter prices as N/A.
let reportedFlags={};

const ROLE_NAMES={HEAD:'Head',WORKER:'Worker',NODE:'Node'};
// Badge colours follow the node's state, the same way the rack panel colours its bays.
const BADGE_LEVELS={serving:'good',idle:'idle','no GPU data':'warn','no response':'crit','not collected':'idle'};
// One card per node in topology order; rebuilt when anything in topology.json changes on the server.
let nodesKey=null;
function syncNodes(next) {
  const key=topologyKey(next);if(nodesKey===key)return;
  nodesKey=key;metas=next;$('#nodes').dataset.count=metas.length<=6?String(metas.length):'many';
  $('#brand-count').textContent=metas.length>1?`× ${metas.length}`:'';buildNodes();
}
// Sensors and the TP rank are shown only when a node reports them; ACPI zones keep their firmware names.
const EXTRA_FIELDS=[['field.disk','disk'],['field.processMemory','process-memory'],['field.cpu','cpu',true],['field.nvme','nvme',true],['field.nic','nic',true],['field.system','system'],['field.rank','rank',true]];
function buildNodes() {
  $('#nodes').innerHTML=metas.map(meta=>`<article class="node" data-node-id="${esc(meta.id)}"><header><h2 data-node="title">${esc(meta.name)}</h2><span class="badge" data-node="state">${esc(un())}</span></header><div class="role"><span data-node="role"></span><span data-node="connection"></span></div><div class="instrument"><div class="gauge"><svg viewBox="0 0 114 72" aria-hidden="true"><path class="track" d="M10 62 A47 47 0 0 1 104 62"/><path class="needle" pathLength="100" stroke-dasharray="0 100" d="M10 62 A47 47 0 0 1 104 62"/></svg><strong data-node="gpu">${esc(un())}</strong><span data-i18n="node.gpuLoad">${esc(t('node.gpuLoad'))}</span></div><div class="readings">${[['node.gpuTemp','temp','°C'],['node.gpuPower','power','W'],['node.freeMemory','memory','GiB'],['node.clock','clock','MHz']].map(([key,field,unit])=>`<div class="reading"><small>${esc(t(key))}</small><b><span data-node="${field}">${esc(un())}</span><em>${unit}</em></b></div>`).join('')}</div></div><div class="mem"><div class="memline"><span data-i18n="node.memoryUsage">${esc(t('node.memoryUsage'))}</span><span data-node="memory-used">${esc(un())}</span></div><div class="meter"><i style="width:0"></i></div></div><details><summary data-node="kernel-summary">${esc(t('node.kernel.checking'))}</summary><div class="thermal"><div class="thermal-head"><h3 data-i18n="thermal.heading">${esc(t('thermal.heading'))}</h3></div><div class="thermal-table" data-node="thermal"></div><p class="thermal-warmup" data-node="thermal-warmup" hidden></p><p class="thermal-note" data-i18n="thermal.note">${esc(t('thermal.note'))}</p></div><div class="extra">${EXTRA_FIELDS.map(([key,field,optional])=>`<span${optional?' data-optional hidden':''}>${esc(t(key))} <b data-node="${field}">${esc(un())}</b></span>`).join('')}<span class="wide" data-optional hidden>${esc(t('field.acpi'))} <b data-node="zones">${esc(un())}</b></span><span class="wide" data-optional hidden>${esc(t('field.container'))} <b data-node="container">${esc(un())}</b></span><span class="wide" data-node="kernel-last"></span><span class="wide" data-node="last-update"></span></div></details></article>`).join('');
}
// Per-sensor thermal rows: the representative max-over-zones series first, then each sensor with its current
// reading and the canonical 1/5/15m means and 5m max. Rows without samples read as "no sample", never as a zero;
// while history is still filling, the sample count says so. The GPU temperature never enters these rows.
function renderThermal(el,meta,node) {
  const wrap=el.querySelector('[data-node="thermal"]');if(!wrap)return;
  const stats=thermal[meta.id]??null,ok=Boolean(node?.ok);
  const zones=ok?Object.entries(node.thermals?.zones??{}).filter(([,value])=>finite(value)):[];
  const current=Object.fromEntries([...zones.map(([name,value])=>[name,value]),
    ['nvme',ok&&finite(node.nvmeCelsius)?node.nvmeCelsius:null],
    ['nic',ok&&finite(node.nicCelsius)?node.nicCelsius:null]]);
  const representative=stats?.representative?{name:t('thermal.representative'),value:zones.length?Math.max(...zones.map(([,value])=>value)):null,stats:stats.representative}:null;
  const rows=[representative,...Object.entries(stats?.sensors??{}).map(([name,s])=>({name,value:current[name]??null,stats:s}))].filter(Boolean);
  const warmupEl=el.querySelector('[data-node="thermal-warmup"]');
  if(warmupEl){
    // Warm-up banner: until the 15m window is fully covered, say per node how many samples over what span
    // have been collected since thermal history started (the widest coverage among this node's series).
    const coverage=Math.max(0,...[stats?.representative,...Object.values(stats?.sensors??{})].filter(Boolean).map(s=>s.coverageMs??0));
    const samples=[stats?.representative,...Object.values(stats?.sensors??{})].filter(Boolean).reduce((max,s)=>Math.max(max,s.samples??0),0);
    const warm=stats&&coverage<15*60_000;
    warmupEl.hidden=!warm;
    if(warm)warmupEl.textContent=t('thermal.warmup',{samples,minutes:fixed(coverage/60_000,1)});
  }
  if(!rows.length){wrap.innerHTML=`<div class="thermal-empty">${esc(un())}</div>`;return;}
  const cell=(value)=>value===undefined||!finite(value)?`<td class="unknown-value">${esc(t('thermal.noSample'))}</td>`:`<td class="num">${fixed(value,1)}</td>`;
  const statCell=(value)=>finite(value)?`<td class="num">${fixed(value,1)}</td>`:`<td class="unknown-value">${esc(t('thermal.noSample'))}</td>`;
  wrap.innerHTML=`<table><thead><tr><th scope="col">${esc(t('thermal.sensor'))}</th><th scope="col">${esc(t('thermal.now'))}</th><th scope="col">${esc(t('thermal.mean1m'))}</th><th scope="col">${esc(t('thermal.mean5m'))}</th><th scope="col">${esc(t('thermal.mean15m'))}</th><th scope="col">${esc(t('thermal.max5m'))}</th></tr></thead><tbody>${rows.map(row=>`<tr><th scope="row">${esc(row.name)}</th>${cell(row.value)}${statCell(row.stats.mean1m)}${statCell(row.stats.mean5m)}${statCell(row.stats.mean15m)}${statCell(row.stats.max5m)}</tr>`).join('')}</tbody></table>`;
}
function renderNode(meta,node) {
  const el=$('#nodes').querySelector(`[data-node-id="${CSS.escape(meta.id)}"]`);if(!el)return;
  const set=(name,value)=>{const field=el.querySelector(`[data-node="${name}"]`);if(!field)return;setCell(field,value);if(field.parentElement.hasAttribute('data-optional'))field.parentElement.hidden=value===UNKNOWN};
  const pending=meta.collect===false||node?.collected===false,ok=Boolean(node?.ok);el.classList.toggle('is-unknown',!ok);
  const target=meta.local?'local':meta.host??'no host';
  set('title',meta.name);set('role',[ROLE_NAMES[meta.role]??meta.role,meta.hardware].filter(Boolean).join(' | '));
  const state=pending?'not collected':!ok?'no response':node.gpu?.available===false?'no GPU data':node.inferenceProcessReady?'serving':'idle';
  set('state',t(`node.${{'not collected':'notCollected','no response':'noResponse','no GPU data':'noGpu',serving:'serving',idle:'idle'}[state]??state}`));el.querySelector('.badge').dataset.level=BADGE_LEVELS[state]??'idle';
  set('connection',pending?t('node.host.notCollected',{target}):ok?t('node.host.ok',{target,ms:fixed(node.latencyMs,0)}):t('node.host.unknown',{target}));
  const gpu=ok?node.gpu:{};set('gpu',finite(gpu?.utilization)?fixed(gpu.utilization,0)+'%':UNKNOWN);el.querySelector('[data-node="gpu"]').classList.toggle('full',finite(gpu?.utilization)&&gpu.utilization>=99.5);
  set('temp',fixed(gpu?.temperature,0));set('power',fixed(gpu?.powerWatts));set('memory',gib(ok?node.memory?.availableBytes:null));set('clock',fixed(gpu?.clockMHz,0));
  const total=ok?node.memory?.totalBytes:null,used=ok?node.memory?.usedBytes:null;
  set('memory-used',finite(total)&&finite(used)?`${gib(used)} / ${gib(total,0)} GiB`:UNKNOWN);
  el.querySelector('.needle').setAttribute('stroke-dasharray',`${finite(gpu?.utilization)?Math.max(0,Math.min(100,gpu.utilization)):0} 100`);
  el.querySelector('.meter i').style.width=finite(total)&&total>0&&finite(used)?`${Math.min(100,used/total*100)}%`:'0%';
  set('disk',ok&&finite(node.disk?.availableBytes)?gib(node.disk.availableBytes,0)+' GiB':UNKNOWN);set('process-memory',ok&&finite(node.processMemoryBytes)?gib(node.processMemoryBytes)+' GiB':UNKNOWN);
  const cpu=ok?node.cpu:null;set('cpu',finite(cpu?.load1)?t('field.cores',{load:fixed(cpu.load1,2),cores:finite(cpu.cores)?cpu.cores:''}):UNKNOWN);
  set('nvme',ok?fixed(node.nvmeCelsius,1,' °C'):UNKNOWN);set('nic',ok?fixed(node.nicCelsius,1,' °C'):UNKNOWN);
  const zones=ok?Object.entries(node.thermals?.zones??{}).filter(([,value])=>finite(value)):[];set('zones',zones.length?zones.map(([name,value])=>`${name} ${fixed(value,1)}`).join(' | ')+' °C':UNKNOWN);
  set('system',ok&&node.systemState?`${node.systemState} (failed ${node.failedUnits})`:UNKNOWN);set('rank',ok&&finite(node.rank)?String(node.rank):UNKNOWN);
  // The container line appears only when the node can see its inference container (Docker access).
  set('container',ok&&node.container?.detected?`${node.container.name} ${node.container.running?t('node.running'):t('node.stopped')} (restarts ${node.container.restarts})`:UNKNOWN);
  const kernel=ok?node.kernelEvents:null;
  set('kernel-summary',kernel?.available?t('node.kernel.summary',{capped:kernel.capped?'≥':'',xid:kernel.xid,capped2:kernel.capped?'≥':'',noMemory:kernel.noMemory}):t('node.kernel.unavailable'));
  set('kernel-last',kernel?.available?(kernel.total?t('node.kernel.last',{time:eventTime(kernel.lastAt),message:kernel.lastMessage||'kernel error'}):t('node.kernel.none')):t('node.kernel.nojournal'));
  set('last-update',pending?t('node.notCollected'):t('node.lastPoll',{time:clockTime(node?.updatedAt)}));
  renderThermal(el,meta,node);
}
const LINK_STROKE={up:['var(--link)',''],slow:['var(--orange)',''],partial:['var(--orange)',''],pending:['var(--orange)','6 5'],down:['var(--red)','6 5'],unknown:['var(--line)','3 4']};
// The interconnect: one line per cable. With one node or no links configured the panel is hidden.
function renderLinks(state) {
  const topology=state?.topology??lastTopology,links=topology?.links??[],layout=fabricLayout(topology);
  $('#fabric-panel').hidden=!layout;$('#body-grid').classList.toggle('no-fabric',!layout);
  if(!layout)return;
  $('#link-rows').innerHTML=links.map(link=>{const live=state?.ringLinks?.[link.id],st=live?.state??'unknown',planes=link.planes??['a','b'],color=st==='up'&&!live.slow?'green':st==='down'?'red':st==='unknown'?'muted':'orange';const rate=plane=>planes.includes(plane)?fixed(live?.[plane]?.rateGbps,2):'—';return `<tr><td>${esc(link.label.replace('–',' ↔ '))}</td><td>${rate('a')}</td><td>${rate('b')}</td><td style="color:var(--${color})">${esc(linkText(live))}</td></tr>`}).join('');
  $('#fabric-links').innerHTML=layout.links.map(line=>{const live=state?.ringLinks?.[line.id],[stroke,dash]=LINK_STROKE[live?.state==='up'&&live.slow?'slow':live?.state??'unknown']??LINK_STROKE.unknown;return `<line x1="${line.x1.toFixed(1)}" y1="${line.y1.toFixed(1)}" x2="${line.x2.toFixed(1)}" y2="${line.y2.toFixed(1)}" style="stroke:${stroke}${dash?`;stroke-dasharray:${dash}`:''}"><title>${esc(links.find(link=>link.id===line.id)?.label??line.id)}: ${esc(linkText(live))}</title></line>`}).join('');
  // Short ids sit in a circle; longer ones in a pill sized to the label, with the full id and name on hover.
  $('#fabric-nodes').innerHTML=layout.nodes.map(node=>{const width=labelWidth(node.label),meta=topology.nodes.find(item=>item.id===node.id),x=node.x.toFixed(1),y=node.y.toFixed(1);const shape=width===38?`<circle cx="${x}" cy="${y}" r="19" style="stroke:${node.color}"/>`:`<rect x="${(node.x-width/2).toFixed(1)}" y="${(node.y-16).toFixed(1)}" width="${width}" height="32" rx="16" style="stroke:${node.color}"/>`;return `<g><title>${esc(node.id)}${meta?.name&&meta.name!==node.id?` | ${esc(meta.name)}`:''}</title>${shape}<text class="label" x="${x}" y="${(node.y+4).toFixed(1)}" text-anchor="middle">${esc(node.label)}</text></g>`}).join('');
  const paths=links.reduce((sum,link)=>sum+(link.planes??['a','b']).length,0),count=$('#fabric-count');
  count.setAttribute('x',layout.caption.x);count.setAttribute('y',layout.caption.y);count.textContent=`${t('fabric.cables',{count:links.length})} | ${t('fabric.paths',{count:paths})}`;
}
function renderCharts(state) {
  const history=state.history||[],end=Date.now(),start=end-range*60_000;
  const rates=history.map(p=>p.outputTokensPerSecond).filter(finite),avg=state.historyStats?.activeOutputTokensPerSecond;
  const max=Math.max(1,...rates,finite(avg)?avg:0)*1.15;
  const d=chartPath(history,'outputTokensPerSecond',{start,end,min:0,max,top:4,bottom:22});$('#output-line').setAttribute('d',d);$('#output-fill').setAttribute('d','');
  $('#avg-line').setAttribute('d',finite(avg)?chartPath([{at:start,value:avg},{at:end,value:avg}],'value',{start,end,min:0,max,top:4,bottom:22}):'');
  const queueMax=Math.max(1,...history.map(p=>p.queue).filter(finite));$('#queue-line').setAttribute('d',chartPath(history,'queue',{start,end,min:0,max:queueMax,top:120,bottom:4}));
  const label=value=>clockTime(value,{seconds:false});
  text('#range-start',label(start));text('#range-mid',label((start+end)/2));text('#range-end',label(end));
  $('#plot-note').hidden=rates.length>0;$('#plot-note').textContent=state.inferenceState==='stopped'?t('note.stopped'):t('note.noOutput');
  for(const kind of ['temp','mem']) {
    // Values are picked per node id from each sample, so an id never collides with the sample's own fields (such as "at").
    const field=kind==='temp'?'temperature':'memoryAvailableBytes',scale=kind==='mem'?2**30:1,ids=metas.map(meta=>meta.id);
    const pick=id=>point=>{const v=point.nodes?.[id]?.[field];return finite(v)?v/scale:null};
    const values=history.flatMap(point=>ids.map(id=>pick(id)(point))).filter(finite),low=kind==='temp'&&values.length?Math.min(...values)-2:0,high=values.length?Math.max(...values)+(kind==='temp'?2:5):1;
    $('#'+kind+'-chart').innerHTML=ids.map((id,index)=>`<path d="${chartPath(history,pick(id),{start,end,width:320,height:80,min:low,max:high})}" fill="none" stroke="${COLORS[index%COLORS.length]}" stroke-width="2" vector-effect="non-scaling-stroke"/>`).join('');
    $('#'+kind+'-legend').innerHTML=metas.map((meta,index)=>{const node=state.nodes?.[meta.id];const value=!node?.ok?UNKNOWN:kind==='temp'?fixed(node.gpu?.temperature,0):gib(node.memory?.availableBytes);return `<span style="color:${COLORS[index%COLORS.length]}">${esc(meta.name)} <b class="num">${value===UNKNOWN?esc(un()):value}</b></span>`}).join('');
  }
}
function renderToday(usage) {
  for(const selector of ['[data-usage]','[data-today]'])document.querySelectorAll(selector).forEach(el=>{const key=el.dataset.usage||el.dataset.today;const value=usage?.error||usage?.reported?.[key]===false?null:usage?.today?.[key];el.textContent=key==='requests'?fixed(value,0):compact(value);el.title=finite(value)?value.toLocaleString('en-US'):''});
  document.querySelectorAll('[data-ledger-zone]').forEach(el=>{el.textContent=ledgerTimeZone?t('ledger.daysIn',{zone:ledgerTimeZone}):''});
  renderPrice();
}
function renderState(state) {
  const age=Date.now()-Date.parse(state.updatedAt);if(!Number.isFinite(age)||age>staleAfterMs(state))throw new Error('stale data');
  latest=state;lastTopology=state.topology??lastTopology;thermal=state.thermal??{};
  if(state.usage?.timeZone&&state.usage.timeZone!==ledgerTimeZone){ledgerTimeZone=state.usage.timeZone;if(!monthPicked&&selectedMonth!==ledgerToday().slice(0,7)){selectedMonth=ledgerToday().slice(0,7);monthLoadedAt=0;rebuildMonths();if(!$('#tokens').hidden)void refreshMonth(true)}}
  syncNodes(nodeOrder(state));$('#shell').classList.remove('stale');
  const v=state.inference,stopped=state.inferenceState==='stopped',nodes=state.nodes||{};
  const online=metas.filter(m=>nodes[m.id]?.ok).length,serving=metas.filter(m=>nodes[m.id]?.ok&&nodes[m.id]?.inferenceProcessReady).length,count=metas.length;
  $('.status').className='status '+(state.status==='healthy'?'':stopped?'stopped':'error');text('#status-title',state.message||t('status.checking'));
  const watts=metas.map(m=>nodes[m.id]).filter(n=>n?.ok&&finite(n.gpu?.powerWatts)).map(n=>n.gpu.powerWatts);
  $('#status-desc').innerHTML=`<span>${esc(t('status.nodes',{online,count}))}</span><span>${esc(t('status.processes',{serving,count}))}</span><span>${esc(t('status.api'))} ${esc(v?.ok?t('status.api.up'):t('status.api.down'))}</span>${watts.length?`<span>${esc(t('status.power',{watts:fixed(watts.reduce((sum,w)=>sum+w,0),1),nodes:watts.length<count?t('status.power.nodes',{served:watts.length,count}):''}))}</span>`:''}`;
  text('#updated-at',clockTime(state.updatedAt));
  text('#model-title',v?.modelName||(stopped?t('model.stopped'):t('model.unknown')));
  text('#model-meta',serving?t('meta.serving',{engine:state.serving?.engine??'Inference',count:plural(serving,'node')}):`${t('meta.monitor',{count:plural(count,'node')})}`);
  document.title=v?.modelName?`${v.modelName} | Spark Scope`:'Spark Scope';
  const empty=stopped?t('model.stopped'):UNKNOWN,value=(number,formatter=fixed)=>v?.ok?formatter(number):empty;
  text('#speed',value(v?.outputTokensPerSecond));text('#legend-speed',value(v?.outputTokensPerSecond));text('#avg',fixed(state.historyStats?.activeOutputTokensPerSecond));text('#queue',value(v?.waitingRequests,n=>fixed(n,0)));
  document.querySelectorAll('[data-field]').forEach(el=>{const key=el.dataset.field;let result=empty;if(v?.ok){if(key==='requests')result=`${fixed(v.runningRequests,0)} / ${fixed(v.waitingRequests,0)}`;else if(key.endsWith('Seconds'))result=duration(v[key]);else if(key.endsWith('Percent'))result=fixed(v[key],1,'%');else result=tokenRate(v[key])}setCell(el,result)});
  metas.forEach(meta=>renderNode(meta,nodes[meta.id]));renderLinks(state);renderCharts(state);renderToday(state.usage);
}
function plural(count,word){return `${count} ${word}${count===1?'':'s'}`}
function failedState() {
  latest=null;thermal={};
  $('#shell').classList.add('stale');$('.status').className='status error';text('#status-title',t('server.notResponding'));text('#status-desc',t('server.untilReturn'));
  metas.forEach(meta=>renderNode(meta,null));renderLinks(null);renderToday(null);for(const id of ['speed','legend-speed','avg','queue'])text('#'+id,UNKNOWN);document.querySelectorAll('[data-field]').forEach(el=>setCell(el,UNKNOWN));$('#plot-note').hidden=false;$('#plot-note').textContent=t('server.lost');
}
async function refresh() {
  if(collecting)return;collecting=true;const requestedRange=range,full=historyRange!==requestedRange||Date.now()-historyAt>=HISTORY_REFRESH_MS;
  let data=null;const timeout=timeoutSignal(8000);
  try{const res=await fetch(`/api/state?minutes=${requestedRange}${full?'':'&history=0'}`,{cache:'no-store',signal:timeout.signal});if(!res.ok)throw new Error('HTTP '+res.status);data=await res.json()}
  catch{if(requestedRange===range)failedState()}
  finally{timeout.done()}
  try{
    if(data&&requestedRange===range){
      if(full){history=data.history??[];historyAt=Date.now();historyRange=requestedRange}else history=mergeLivePoint(history,livePoint(data),requestedRange*60_000);
      renderState({...data,history});
    }
  }catch(error){
    // A drawing problem is not a lost connection: keep the last good view and say what broke.
    if(error?.message==='stale data')failedState();else console.error('Spark Scope could not draw the latest state:',error);
  }finally{collecting=false;if(requestedRange!==range)void refresh()}
}

function rebuildMonths() {
  const locale=localeName(),current=ledgerToday().slice(0,7),choices=monthOptions(earliestMonth,current);
  if(!choices.includes(selectedMonth))choices.push(selectedMonth);
  $('#token-month').innerHTML=choices.sort().reverse().map(month=>`<option value="${month}"${month===selectedMonth?' selected':''}>${monthLabel(month,locale)}</option>`).join('');
}
// A counter the engine does not export (usage.reported[key] === false) reads as unknown, not as 0.
let unreported={};
function metricCell(key,value,tag='td') { if(unreported[key]&&!value)return `<${tag} data-metric="${key}" class="unknown-value">${esc(un())}</${tag}>`; return `<${tag} data-metric="${key}" data-count="${value}" title="${value.toLocaleString('en-US')}">${key==='requests'?fixed(value,0):compact(value)}</${tag}>`; }
// The last rendered monthly payload, so the price panel can follow the selected month without a second fetch.
function renderMonthAside(){if(monthUsage)renderMonth(monthUsage);else clearMonth(t('ledger.loading'));}
function renderMonth(usage) {
  if(usage.timeZone)ledgerTimeZone=usage.timeZone;
  unreported=Object.fromEntries(Object.entries(usage.reported??{}).filter(([,seen])=>seen===false).map(([key])=>[key,true]));
  earliestMonth=usage.firstMonth;rebuildMonths();const locale=localeName(),current=selectedMonth===usage.day.slice(0,7),name=monthLabel(selectedMonth,locale).split(' ')[0];
  text('#month-title',current?t('ledger.monthToDate',{name}):t('ledger.monthName',{name}));text('#month-period',current?`${dayLabel(selectedMonth+'-01',locale)} – ${dayLabel(usage.day,locale)}`:monthLabel(selectedMonth,locale));
  $('#month-period').classList.remove('month-load-error');$('#today-tokens').hidden=!current;
  const metrics=[['ledger.totalTokens','total'],['ledger.cacheRead','cache'],['ledger.newInput','compute'],['ledger.output','output'],['ledger.logicalInput','input'],['ledger.requests','requests']];
  const metricsHtml=metrics.map(([key,field])=>`<div class="${field==='total'?'total-tokens':''}"><small>${esc(t(key))}</small>${metricCell(field,usage.totals[field],'b')}</div>`).join('');
  if($('#month-metrics').innerHTML!==metricsHtml)$('#month-metrics').innerHTML=metricsHtml;
  const days=[...usage.days].sort((a,b)=>b.day.localeCompare(a.day));const fields=['cache','compute','output','input','requests'];
  $('#token-days').innerHTML=days.length?days.map(day=>`<tr><th scope="row">${esc(dayLabel(day.day,locale))}</th>${fields.map(k=>metricCell(k,day[k])).join('')}</tr>`).join(''):`<tr><td colspan="6">${esc(t('ledger.empty'))}</td></tr>`;
  $('#token-month-total').innerHTML=`<tr><th scope="row">${esc(t('ledger.table.monthTotal'))}</th>${fields.map(k=>metricCell(k,usage.totals[k])).join('')}</tr>`;
  const number=Number(selectedMonth.slice(5)),lastDay=current?Number(usage.day.slice(8)):new Date(Date.UTC(Number(selectedMonth.slice(0,4)),number,0)).getUTCDate();const recent=[];for(let d=Math.max(1,lastDay-6);d<=lastDay;d++){const date=selectedMonth+'-'+String(d).padStart(2,'0');recent.push({day:date,value:usage.days.find(row=>row.day===date)?.output??null})}
  const max=Math.max(1,...recent.map(p=>p.value).filter(finite));$('#token-chart').innerHTML=recent.map(row=>`<div class="day-bar" style="--h:${finite(row.value)?row.value/max*85:0}%" title="${dayLabel(row.day,locale)}: ${finite(row.value)?`${t('ledger.output')} ${fixed(row.value,0)}`:esc(t('ledger.noRecord'))}"><i></i><span>${dayLabel(row.day,locale)}</span></div>`).join('');
  monthUsage=usage;renderToday(latest?.usage);
}
function clearMonth(message,isError=false) {
  const locale=localeName(),name=monthLabel(selectedMonth,locale).split(' ')[0];
  text('#month-title',t('ledger.monthName',{name}));text('#month-period',message);$('#month-period').classList.toggle('month-load-error',isError);
  $('#month-metrics').innerHTML='';$('#token-days').innerHTML=`<tr><td colspan="6">${esc(message)}</td></tr>`;$('#token-month-total').innerHTML='';$('#token-chart').innerHTML='';$('#today-tokens').hidden=true;
}
async function refreshMonth(force=false) {
  if(!force&&(monthController||Date.now()-monthLoadedAt<10000))return;
  const sequence=++monthSequence,month=selectedMonth;monthController?.abort();const controller=new AbortController();monthController=controller;const timer=setTimeout(()=>controller.abort(),8000);
  try{const res=await fetch('/api/usage?month='+encodeURIComponent(month),{cache:'no-store',signal:controller.signal});if(!res.ok)throw new Error('HTTP '+res.status);const payload=validateMonth(await res.json(),month);if(sequence===monthSequence){renderMonth(payload);monthLoadedAt=Date.now()}}catch{if(sequence===monthSequence)clearMonth(t('ledger.loadError'),true)}finally{clearTimeout(timer);if(sequence===monthSequence)monthController=null}
}
function selectTab(btn,updateHash=true) {
  document.querySelectorAll('[role=tab]').forEach(b=>{b.setAttribute('aria-selected',String(b===btn));b.tabIndex=b===btn?0:-1;$('#'+b.getAttribute('aria-controls')).hidden=b!==btn});
  const tokens=btn.id==='tab-tokens';if(updateHash)location.hash=tokens?'tokens':'scope';if(tokens)void refreshMonth();
}
document.querySelectorAll('[role=tab]').forEach(btn=>{btn.addEventListener('click',()=>selectTab(btn));btn.addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const next=e.key==='Home'?$('#tab-scope'):e.key==='End'?$('#tab-tokens'):btn.id==='tab-scope'?$('#tab-tokens'):$('#tab-scope');selectTab(next);next.focus()}})});
window.addEventListener('hashchange',()=>selectTab($(location.hash==='#tokens'?'#tab-tokens':'#tab-scope'),false));
document.querySelectorAll('[data-range]').forEach(btn=>btn.addEventListener('click',()=>{range=Number(btn.dataset.range);document.querySelectorAll('[data-range]').forEach(b=>b.setAttribute('aria-pressed',String(b===btn)));void refresh()}));
$('#token-month').addEventListener('change',()=>{monthPicked=true;selectedMonth=$('#token-month').value;monthLoadedAt=0;clearMonth(t('ledger.loading'));void refreshMonth(true)});

// ---- API price equivalence: static local metadata over the ledger's own per-model counters. ----
const usd = value => '$' + value.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
function setText(el,value){if(el.textContent!==value)el.textContent=value}
// Mobile: each model is a vertical definition-list card, so nothing needs a horizontal gesture to be read.
// Cards are keyed by the ledger's exact model string via priceCardKey (no trim, no case fold), so every
// distinct model_name string gets its own card and reuse across polls keeps scroll position and focus.
// Case folding happens later in priceFor only — the ledger groups model names case-sensitively.
const PRICE_COMPONENTS=[['uncachedInput','price.uncachedInput','compute'],['cacheInput','price.cacheInput','cache'],['output','price.output','output']];
function makePriceCard() {
  const card=document.createElement('article');card.className='price-card';
  card.innerHTML=`<h4 class="price-card-name"></h4><dl>${PRICE_COMPONENTS.map(([component])=>`<div class="price-line" data-component="${component}"><dt></dt><dd class="num"><span class="price-tokens"></span><span class="price-cost"></span><small class="price-rate"></small></dd></div>`).join('')}<div class="price-line price-total" data-component="total"><dt></dt><dd class="num"><span class="price-cost"></span></dd></div></dl>`;
  return card;
}
function priceCardData(modelName,counters) {
  const equivalence=priceEquivalent(modelName,{...counters,reported:reportedFlags});
  return {key:priceCardKey(modelName),name:modelName||t('model.unknown'),counters,equivalence,mapping:priceFor(modelName)};
}
function patchPriceCard(card,data) {
  setText(card.querySelector('.price-card-name'),data.name);
  const rates=data.mapping?.perMillion;
  for(const [component,key,tokenKey] of PRICE_COMPONENTS){
    const line=card.querySelector(`[data-component="${component}"]`),tokens=data.counters?.[tokenKey],bad=tokens===undefined||!finite(tokens);
    setText(line.querySelector('dt'),t(key));
    const tokenEl=line.querySelector('.price-tokens');setText(tokenEl,bad?un():compact(tokens));tokenEl.classList.toggle('unknown-value',bad);
    const cost=data.equivalence.available?data.equivalence.components[component]:null,badCost=cost===null||cost===undefined;
    const costEl=line.querySelector('.price-cost');setText(costEl,badCost?t('price.na'):usd(cost));costEl.classList.toggle('unknown-value',badCost);
    const rateEl=line.querySelector('.price-rate'),rate=rates?.[component];setText(rateEl,rate===undefined?'':t('price.rate',{rate:rate.toFixed(2)}));rateEl.hidden=rate===undefined;
  }
  const complete=data.equivalence.available&&data.equivalence.complete,total=data.equivalence.total,line=card.querySelector('[data-component="total"]');
  setText(line.querySelector('dt'),t('price.total'));
  const costEl=line.querySelector('.price-cost');setText(costEl,complete?usd(total):t('price.na'));costEl.classList.toggle('unknown-value',!complete);
}
function syncPriceCards(container,cards) {
  const stale=new Map([...container.children].map(el=>[el.dataset.priceKey,el]));let prev=null;
  for(const data of cards){
    let card=stale.get(data.key);
    if(card)stale.delete(data.key);else{card=makePriceCard();card.dataset.priceKey=data.key}
    patchPriceCard(card,data);
    if((prev?prev.nextSibling:container.firstChild)!==card){prev?prev.after(card):container.prepend(card)}
    prev=card;
  }
  for(const card of stale.values())card.remove();
}
function renderPrice() {
  const usage=latest?.usage,panel=$('#price-panel');
  if(!usage?.persistent){panel.hidden=true;return;}
  panel.hidden=false;reportedFlags=usage.reported??{};
  const currentModel=usage.modelName??latest?.inference?.modelName??null,mapping=priceFor(currentModel),rates=mapping?.perMillion;
  setText($('#price-mapping-line'),mapping?t('price.mapping',{local:currentModel,hosted:mapping.hosted,provider:mapping.provider}):t('price.unmapped'));
  $('#price-mapping .price-rates').hidden=!rates;
  if(rates)for(const [component] of PRICE_COMPONENTS)setText($(`#price-mapping [data-rate="${component}"]`),t('price.rate',{rate:rates[component].toFixed(2)}));
  const monthCards=(monthUsage?.models??[]).map(model=>priceCardData(model.modelName,model));
  $('#price-month').hidden=!monthCards.length;
  if(monthCards.length)syncPriceCards($('[data-price-group="month"]'),monthCards);
  const allCards=(usage.models??[]).map(model=>priceCardData(model.modelName,model));
  $('#price-alltime').hidden=!allCards.length;
  if(allCards.length)syncPriceCards($('[data-price-group="alltime"]'),allCards);
  const source=$('#price-source');setText(source,t('price.source',{source:PRICE_META.source,checked:PRICE_META.checkedAt}));source.hidden=false;
}
applyStaticTexts();buildNodes();rebuildMonths();clearMonth(t('ledger.loading'));selectTab($(location.hash==='#tokens'?'#tab-tokens':'#tab-scope'),false);void refresh();
setInterval(()=>{void refresh();if(!$('#tokens').hidden)void refreshMonth()},2000);
