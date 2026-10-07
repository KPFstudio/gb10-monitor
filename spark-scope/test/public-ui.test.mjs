import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compact, duration, tokenRate, chartPath, eventTime, validateMonth, monthOptions, monthLabel, dayLabel, localDay, nodeOrder, linkText, fabricLayout, nodeLabel, labelWidth, nextTheme, COLORS, PRICE_META, priceFor, priceEquivalent, priceCardKey } from '../public/view-data.js';
import { MESSAGES, LANGS, detectLanguage, t, setLanguage, localeName } from '../public/i18n.js';
import { loadTopology, publicTopology } from '../lib/topology.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const example = (count) => publicTopology(loadTopology(path.join(ROOT, 'examples', `topology.${count}-node.json`), { fallback: false }));

test('token units promote to billions without hiding meaningful precision', () => {
  assert.equal(compact(1_061_000_000), '1.06B');
  assert.equal(compact(1_000_000_000), '1B');
  assert.equal(compact(999_000_000), '999M');
  assert.equal(compact(9_552_810), '9.55M');
  assert.equal(compact(1_500), '1.5K');
  assert.equal(compact(0), '0');
  assert.equal(compact(null), 'unknown');
});

test('numbers pick their unit after rounding, so a boundary never reads 1000 of the smaller unit', () => {
  assert.equal(compact(999_950), '1M');
  assert.equal(compact(999.6), '1K');
  assert.equal(compact(999_499), '999K');
  assert.equal(duration(0.9996), '1.00 s');
  assert.equal(duration(0.9994), '999 ms');
  assert.equal(tokenRate(99.96), '100 tok/s');
  assert.equal(tokenRate(99.94), '99.9 tok/s');
  assert.equal(tokenRate(null), 'unknown');
});

test('a kernel event from an earlier day carries its date', () => {
  const now = Date.parse('2026-10-02T12:00:00');
  assert.match(eventTime('2026-10-02T09:15:00', now), /^\d\d:\d\d:\d\d$/);
  assert.match(eventTime('2026-10-01T23:12:04', now), /^Oct 1 \d\d:\d\d:\d\d$/);
  assert.equal(eventTime(null, now), 'unknown');
});

test('the theme button cycles from the system look to the other one, the system one picked by hand, then system', () => {
  assert.equal(nextTheme(null, 'light'), 'dark');
  assert.equal(nextTheme('dark', 'light'), 'light');
  assert.equal(nextTheme('light', 'light'), null);
  assert.equal(nextTheme(null, 'dark'), 'light');
  assert.equal(nextTheme('light', 'dark'), 'dark');
  assert.equal(nextTheme('dark', 'dark'), null);
  assert.equal(nextTheme('purple', 'dark'), 'light');
});

test('monthly totals count cached input once and reject inconsistent responses', () => {
  const totals = {input:1000, compute:200, cache:800, output:100, requests:2, total:1100};
  const payload = {month:'2026-09', day:'2026-09-17', totals, days:[{day:'2026-09-17', ...totals}]};
  assert.equal(validateMonth(payload,'2026-09').totals.total,1100);
  assert.throws(()=>validateMonth(payload,'2026-08'));
  assert.throws(()=>validateMonth({...payload,totals:{...totals,output:101}},'2026-09'));
  const double = {...totals,total:1900};
  assert.throws(()=>validateMonth({...payload,totals:double,days:[{day:'2026-09-17',...double}]},'2026-09'));
  assert.throws(()=>validateMonth({...payload,error:'database unavailable'},'2026-09'));
});

test('charts leave missing observations as gaps and use elapsed time on the x axis', () => {
  const d = chartPath([{at:0,v:0},{at:1000,v:1},{at:2000,v:null},{at:4000,v:2}], 'v', {start:0,end:4000,width:100,height:100,max:2,top:0,bottom:0});
  assert.equal(d,'M0.00 100.00 L25.00 50.00 M100.00 0.00');
});

test('a node whose id is "at" still gets its own trend line, because values are picked per node', () => {
  const history = [{ at: 0, nodes: { at: { temperature: 40 } } }, { at: 1000, nodes: { at: { temperature: 60 } } }];
  const d = chartPath(history, (point) => point.nodes.at.temperature, { start: 0, end: 1000, width: 100, height: 100, min: 40, max: 60, top: 0, bottom: 0 });
  assert.equal(d, 'M0.00 100.00 L100.00 0.00');
});

test('long node ids are shortened in the cable diagram and get a pill wide enough for the label', () => {
  assert.equal(nodeLabel('00'), '00');
  assert.equal(nodeLabel('gb10-rack-node-1'), 'gb10-rack…');
  assert.equal(labelWidth('00'), 38);
  assert.ok(labelWidth('gb10-rack…') >= 10 * 7.2 + 12);
  const layout = fabricLayout(example(4));
  assert.deepEqual(layout.nodes.map((node) => node.label), ['1', '2', '3', '4']);
});

test('eight nodes get eight different colours, and every colour is defined for both themes', () => {
  assert.equal(new Set(COLORS).size, 8);
  const css = readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  const light = css.match(/:root\{[^}]*\}/)[0], dark = css.match(/html\[data-theme="dark"\]\{[^}]*\}/)[0];
  for (const color of COLORS) {
    const token = color.match(/var\((--[a-z]+)\)/)[1];
    assert.ok(light.includes(token + ':'), `${token} missing from the light theme`);
    if (token !== '--ink') assert.ok(dark.includes(token + ':'), `${token} missing from the dark theme`);
  }
});

test('month selection crosses years; calendar days follow the given time zone', () => {
  assert.deepEqual(monthOptions('2025-11','2026-02'),['2026-02','2026-01','2025-12','2025-11']);
  const at = Date.parse('2026-09-30T15:00:00Z');
  assert.equal(localDay(at, 'UTC'), '2026-09-30');
  assert.equal(localDay(at, 'Asia/Tokyo'), '2026-10-01');
  // An unknown zone falls back to the viewer's own instead of breaking the page.
  assert.match(localDay(at, 'Not/AZone'), /^2026-(09-30|10-01)$/);
  assert.equal(monthLabel('2026-09'), 'September 2026');
  assert.equal(dayLabel('2026-09-01'), 'Sep 1');
});

test('cards follow the server topology and links are described without guessing', () => {
  const topology = { nodes: [{ id: '1', name: 'spark-1', collect: false }, { id: '2', name: 'spark-2' }, { id: '3', name: 'spark-3' }] };
  assert.deepEqual(nodeOrder({ topology, nodes: {} }).map(node => node.name), ['spark-1', 'spark-2', 'spark-3']);
  assert.deepEqual(nodeOrder({ nodes: { a: { host: 'box-a' } } }).map(node => node.name), ['box-a']);
  assert.equal(linkText({ state: 'pending' }), 'not cabled yet');
  assert.equal(linkText({ state: 'partial', a: { up: true }, b: { up: false } }), 'A up, B down');
  assert.equal(linkText({ state: 'up', slow: true }), 'A/B up (slow)');
  assert.equal(linkText({ state: 'up', planes: ['a'] }), 'A up');
  assert.equal(linkText(undefined), 'unknown');
});

test('one node, or nodes without links, draw no interconnect diagram', () => {
  assert.equal(fabricLayout(example(1)), null);
  assert.equal(fabricLayout({ ...example(2), links: [] }), null);
  assert.equal(fabricLayout(null), null);
  // A link to a node the topology does not list is skipped rather than drawn to nowhere.
  assert.equal(fabricLayout({ nodes: example(2).nodes, links: [{ id: 'x', nodes: ['1', '9'] }] }), null);
});

test('two cables between two nodes are drawn as two visibly separate lines', () => {
  const layout = fabricLayout(example(2));
  assert.equal(layout.nodes.length, 2);
  // The pair sits side by side, so both cables run horizontally.
  assert.equal(layout.nodes[0].y.toFixed(1), layout.nodes[1].y.toFixed(1));
  assert.ok(layout.nodes[0].x < layout.nodes[1].x);
  const [first, second] = layout.links;
  assert.deepEqual(layout.links.map(line => line.id), ['1-2a', '1-2b']);
  assert.ok(Math.abs(first.y1 - second.y1) >= 10, 'parallel cables are spread apart');
  assert.ok(Math.abs(first.y1 - first.y2) < 0.01 && Math.abs(second.y1 - second.y2) < 0.01, 'each cable stays parallel to the pair');
  // Both stay within the node circles (radius 19), so they still visibly connect the two nodes.
  for (const line of layout.links) assert.ok(Math.abs(line.y1 - layout.nodes[0].y) < 19);
  // The caption moves off the cables.
  assert.ok(layout.caption.y > layout.nodes[0].y + 19);
  // A single cable is drawn straight between the centres.
  const single = fabricLayout({ ...example(2), links: [example(2).links[0]] });
  assert.equal(single.links[0].y1.toFixed(1), single.nodes[0].y.toFixed(1));
});

test('three and four nodes are drawn as a ring with one line per cable', () => {
  for (const count of [3, 4]) {
    const layout = fabricLayout(example(count));
    assert.equal(layout.links.length, count);
    const points = new Set(layout.nodes.map(node => `${node.x.toFixed(0)},${node.y.toFixed(0)}`));
    assert.equal(points.size, count, 'every node has its own position');
    for (const line of layout.links) {
      const ends = [[line.x1, line.y1], [line.x2, line.y2]];
      for (const [x, y] of ends) assert.ok(layout.nodes.some(node => Math.hypot(node.x - x, node.y - y) < 0.01), 'ring cables run centre to centre');
    }
  }
});

// The server's Content-Security-Policy enforces this at run time (tools/render.mjs fails on a violation); this
// catches it in the source: every src, href, url(), import and fetch target is a path on this server.
test('the web page and the rack panel load nothing from other hosts', () => {
  const files = readdirSync(path.join(ROOT, 'public'), { recursive: true }).filter(file => /\.(html|css|js)$/.test(file));
  assert.ok(files.includes('index.html') && files.some(file => file.endsWith('rack.js')));
  const local = (target) => !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('//');
  for (const file of files) {
    const content = readFileSync(path.join(ROOT, 'public', file), 'utf8');
    assert.ok(!/https?:\/\//.test(content), `${file} references a remote URL`);
    assert.ok(!/@import/.test(content), `${file} imports a stylesheet`);
    const targets = [
      ...content.matchAll(/\b(?:src|href)="([^"]*)"/g),
      ...content.matchAll(/url\(\s*['"]?([^'")]+)/g),
      ...content.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
      ...content.matchAll(/\b(?:fetch|getJson)\(\s*[`'"]([^`'"]+)/g),
    ].map((match) => match[1].trim());
    for (const target of targets) assert.ok(local(target), `${file} loads ${target} from another host`);
  }
  // The checks themselves catch the forms a plain "http" search would miss.
  assert.equal(local('//cdn.example/x.js'), false);
  assert.equal(local('data:text/css,x'), false);
  assert.equal(local('/api/state'), true);
});

test("shipped pages and server strings separate items with bars, not middle dots", async () => {
  const { readdirSync } = await import('node:fs');
  const files = (dir) => readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(path.join(dir, entry.name)) : /\.(m?js|html|css)$/.test(entry.name) ? [path.join(dir, entry.name)] : []);
  const offenders = [...files('public'), ...files('lib'), 'server.mjs'].filter((file) => readFileSync(path.join(ROOT, file), 'utf8').includes('·'));
  assert.deepEqual(offenders, []);
});

test("both pages link the favicon files that ship with them", async () => {
  const { existsSync } = await import('node:fs');
  for (const page of ['public/index.html', 'public/rack/index.html']) {
    const html = readFileSync(path.join(ROOT, page), 'utf8');
    for (const href of ['/favicon.svg', '/favicon-32.png', '/apple-touch-icon.png']) {
      assert.match(html, new RegExp(`href="${href}"`), `${page} links ${href}`);
      assert.ok(existsSync(path.join(ROOT, 'public', href)), `${href} exists`);
    }
  }
  assert.ok(existsSync(path.join(ROOT, 'public', 'favicon.ico')));
});

test("a change to any card field of the topology rebuilds the cards, not only a change of ids", async () => {
  const { topologyKey } = await import('../public/view-data.js');
  const before = [{ id: '1', name: 'spark-1', host: 'spark-1', role: 'HEAD', collect: false }];
  assert.equal(topologyKey(before), topologyKey([{ ...before[0] }]));
  assert.notEqual(topologyKey(before), topologyKey([{ ...before[0], name: 'renamed' }]));
  assert.notEqual(topologyKey(before), topologyKey([{ ...before[0], collect: true }]));
});

test("data counts as stale after three of the server's slower poll intervals, never sooner than 20 s", async () => {
  const { staleAfterMs } = await import('../public/view-data.js');
  assert.equal(staleAfterMs({}), 20_000);
  assert.equal(staleAfterMs({ pollIntervals: { nodeMs: 5000, apiMs: 2000 } }), 20_000);
  assert.equal(staleAfterMs({ pollIntervals: { nodeMs: 30_000, apiMs: 30_000 } }), 90_000);
});

test("a poll without history adds its own sample to the history the page already has", async () => {
  const { livePoint, mergeLivePoint } = await import('../public/view-data.js');
  const state = {
    updatedAt: '2026-10-02T03:00:02Z',
    inference: { ok: true, updatedAt: '2026-10-02T03:00:02Z', outputTokensPerSecond: 61.3, promptTokensPerSecond: 2104, runningRequests: 2, waitingRequests: 0 },
    nodes: { 1: { ok: true, gpu: { temperature: 57 }, memory: { availableBytes: 9.5 * 2 ** 30 } }, 2: { ok: false } },
  };
  const point = livePoint(state);
  assert.deepEqual(point, {
    at: Date.parse('2026-10-02T03:00:02Z'), outputTokensPerSecond: 61.3, promptTokensPerSecond: 2104, runningRequests: 2, queue: 0,
    nodes: { 1: { temperature: 57, memoryAvailableBytes: 9.5 * 2 ** 30 }, 2: { temperature: null, memoryAvailableBytes: null } },
  });
  const old = { at: point.at - 61 * 60_000 }, recent = { at: point.at - 2000 };
  assert.deepEqual(mergeLivePoint([old, recent], point, 60 * 60_000), [recent, point]);
  // The same sample twice, or an older one, changes nothing.
  assert.deepEqual(mergeLivePoint([recent, point], point, 60 * 60_000), [recent, point]);
  assert.equal(livePoint({ inference: { ok: false }, updatedAt: '2026-10-02T03:00:02Z' }).outputTokensPerSecond, null);
});

test("timeouts and media-query listeners also work where Safari lacks the newer APIs", async () => {
  const { timeoutSignal, onMediaChange } = await import('../public/view-data.js');
  const timed = timeoutSignal(10);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(timed.signal.aborted, true);
  const cancelled = timeoutSignal(10);
  cancelled.done();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(cancelled.signal.aborted, false);
  const calls = [];
  onMediaChange({ addListener: (fn) => calls.push(['legacy', fn]) }, () => {});
  onMediaChange({ addEventListener: (type, fn) => calls.push([type, fn]) }, () => {});
  assert.deepEqual(calls.map(([kind]) => kind), ['legacy', 'change']);
});

test("both language dictionaries cover exactly the same keys, and ja is detected before everything else", () => {
  const en = Object.keys(MESSAGES.en).sort(), ja = Object.keys(MESSAGES.ja).sort();
  assert.deepEqual(ja, en, 'the ja dictionary must not drift from the en one');
  assert.ok(en.length > 80, 'the dictionary covers the dashboard, sensors, ledger and price views');
  assert.deepEqual(LANGS, ['en', 'ja']);
  const navigator = (languages) => ({ languages, language: languages?.[0] });
  const storage = (saved) => ({ getItem: (key) => (key === 'spark-scope-lang' ? saved : null) });
  assert.equal(detectLanguage(storage('ja'), navigator(['en-US'])), 'ja', 'a saved preference wins over the browser');
  assert.equal(detectLanguage(storage(null), navigator(['en-US', 'ja-JP'])), 'en', 'the first browser language wins');
  assert.equal(detectLanguage(storage(null), navigator(['ja-JP'])), 'ja');
  assert.equal(detectLanguage(storage(null), navigator(['ja'])), 'ja');
  assert.equal(detectLanguage(storage('purple'), navigator(['fr-FR'])), 'en', 'an unknown saved value falls back to detection');
  assert.equal(detectLanguage(undefined, undefined), 'en');
});

test("translations fill placeholders and switch without touching anything else", () => {
  assert.equal(setLanguage('ja'), 'ja');
  assert.equal(t('ledger.cacheRead'), 'キャッシュ読み');
  assert.equal(t('status.nodes', { online: 2, count: 3 }), 'ノード 2/3');
  assert.equal(t('thermal.warmup', { samples: 12, minutes: '2.5' }), '収集中（15分中 2.5 分・12 サンプル）');
  assert.equal(localeName(), 'ja-JP');
  assert.equal(setLanguage('en'), 'en');
  assert.equal(t('ledger.cacheRead'), 'Cache read');
  assert.equal(t('price.total'), 'Total');
  assert.equal(t('nonexistent.key'), 'nonexistent.key', 'a missing key shows itself instead of going silent');
});

test("only the verified model mapping is priced, each component counts once, and N/A is never free", () => {
  // The verified example: 1M uncached input + 1M output = $0.65.
  const full = priceEquivalent('GLM-5.3-Flash-FP8', { compute: 1_000_000, cache: 0, output: 1_000_000, reported: { compute: true, cache: true, output: true } });
  assert.equal(full.available, true);
  assert.deepEqual(full.components, { uncachedInput: 0.15, cacheInput: 0, output: 0.5 });
  assert.equal(full.total, 0.65, 'cached input is priced at its own rate, never added to uncached input again');
  // Cache hits price at the cache rate, not twice.
  const cached = priceEquivalent('glm-5.3-flash-fp8', { compute: 200_000, cache: 800_000, output: 100_000, reported: { compute: true, cache: true, output: true } });
  assert.ok(Math.abs(cached.total - (0.15 * 0.2 + 0.03 * 0.8 + 0.5 * 0.1)) < 1e-9);
  // A finite value (even zero) with a missing report flag prices as N/A: the flag must be explicitly true.
  const unflagged = priceEquivalent('GLM-5.3-Flash-FP8', { compute: 0, cache: 0, output: 0 });
  assert.equal(unflagged.components.uncachedInput, null);
  assert.equal(unflagged.components.cacheInput, null);
  assert.equal(unflagged.components.output, null);
  assert.equal(unflagged.complete, false);
  assert.equal(unflagged.total, null, 'a missing report flag makes the breakdown incomplete, never free');
  // An unexported counter is never priced as zero, and the total disappears with it.
  const partial = priceEquivalent('GLM-5.3-Flash-FP8', { compute: 1_000_000, cache: 0, output: 1_000_000, reported: { compute: true, cache: false, output: true } });
  assert.equal(partial.components.cacheInput, null);
  assert.equal(partial.complete, false);
  assert.equal(partial.total, null, 'no total without every component: output is never estimated alone');
  // Unknown models, unknown tokens, negative garbage: N/A (not free), and no exception.
  assert.equal(priceEquivalent('unpriced-model-x', { compute: 1, cache: 0, output: 1 }).available, false);
  assert.equal(priceEquivalent(null, { compute: 1, cache: 0, output: 1 }).available, false);
  assert.equal(priceEquivalent('GLM-5.3-Flash-FP8', {}).complete, false);
  assert.equal(priceEquivalent('GLM-5.3-Flash-FP8', { compute: -5, cache: 0, output: 1 }).components.uncachedInput, null);
  // The mapping itself is static metadata with its checked date, provider and source.
  assert.deepEqual(priceFor('GLM-5.3-Flash-FP8').perMillion, { uncachedInput: 0.15, cacheInput: 0.03, output: 0.5 });
  // The checked date is date-only: the UI must not imply a recorded time-of-day.
  assert.equal(PRICE_META.checkedAt, '2026-10-03 JST (exact clock time not recorded)');
  assert.match(PRICE_META.checkedAt, /\(exact clock time not recorded\)$/);
  assert.equal(PRICE_META.source, 'z.ai/pricing');
  assert.equal(PRICE_META.currency, 'USD');
});

// The langchange listener can fire during initLanguage(), long before the app module finishes
// evaluating. Any variable it reads must therefore be initialised before the listener line,
// not declared further down with `let` (which would throw a temporal-dead-zone ReferenceError).
test('the langchange listener reads only bindings declared before the listener is registered', () => {  const source = readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const lines = source.split('\n');
  const listenerLine = lines.findIndex(line => line.includes("addEventListener('langchange'"));
  assert.ok(listenerLine !== -1, 'the langchange listener is registered');
  const read = [...new Set([...lines[listenerLine].matchAll(/\b(monthUsage|latest|metas)\b/g)].map(m => m[1]))];
  for (const name of read) {
    const declarations = lines.map((line, index) => [line, index]).filter(([line]) => new RegExp(`^(?:let|const|var)\\b.*\\b${name}\\s*=[^=]`).test(line));
    assert.equal(declarations.length, 1, `${name} is declared exactly once`);
    assert.ok(declarations[0][1] < listenerLine, `${name} is declared before the langchange listener`);
  }
});

// Mobile pricing fix: the per-model price details are vertical definition-list cards, keyed by model name and
// patched in place on every poll. No horizontal scroller (the previous fix is explicitly rejected), and no
// innerHTML rebuild that would reset the reader's scroll position or focus on each two-second refresh.
test('price details render as keyed vertical cards, with no horizontal scroller anywhere in the price view', () => {
  const app = readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const css = readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  const page = readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  // The scroller markup and its styles are gone, not merely unused.
  assert.ok(!app.includes('price-table-scroll'), 'app.js no longer builds .price-table-scroll');
  assert.ok(!app.includes('class="price-table"'), 'app.js no longer builds .price-table');
  assert.ok(!page.includes('price-table'), 'index.html ships no horizontal price table');
  assert.ok(!css.includes('price-table-scroll') && !css.includes('.price-table'), 'styles.css no longer styles the scroller');
  // Cards are definition lists with one line per priced component plus a total line.
  const card = app.match(/function makePriceCard\(\)[\s\S]*?return card;/);
  assert.ok(card, 'makePriceCard() builds the card DOM');
  assert.ok(card[0].includes('<dl>'), 'the card body is a definition list');
  assert.ok(/data-component="\$\{component\}"/.test(card[0]) && /data-component="total"/.test(card[0]), 'each card has one line per component plus a total line');
  const components = app.match(/const PRICE_COMPONENTS=\[\[.*?\]\];/);
  assert.ok(components, 'the priced components are listed in one place');
  assert.ok(['uncachedInput', 'cacheInput', 'output'].every((name) => components[0].includes(`'${name}'`)), 'uncached input, cached input and output are each priced separately');
  // Keyed updates: cards carry a model key and are reused instead of rebuilt.
  assert.match(app, /card\.dataset\.priceKey=data\.key/, 'each card is keyed by its model name');
  assert.match(app, /priceCardKey\(modelName\)/, 'the card key comes from the shared priceCardKey helper');
  assert.match(app, /function syncPriceCards\(container,cards\)/, 'syncPriceCards() reuses keyed cards');
  assert.match(app, /function setText\(el,value\)\{if\(el\.textContent!==value\)el\.textContent=value\}/, 'text is patched only when it actually changes');
  assert.ok(!/\.innerHTML=/.test(app.slice(app.indexOf('function renderPrice'))), 'renderPrice() no longer rebuilds any price markup via innerHTML');
  // CSS: the card grid never overflows the viewport and the lines wrap instead of pushing width.
  assert.match(css, /\.price-cards\{display:grid;gap:10px;grid-template-columns:repeat\(auto-fill,minmax\(min\(100%,360px\),1fr\)\);max-width:920px\}/, 'the card grid is capped on desktop and cannot exceed its container');
  assert.match(css, /\.price-card\{[^}]*min-width:0/, 'cards shrink below their min-content width');
  assert.match(css, /\.price-line\{[^}]*flex-wrap:wrap/, 'card lines wrap instead of overflowing');
  assert.match(css, /\.price-card-name\{[^}]*overflow-wrap:anywhere/, 'long model names wrap inside the card');
  const priceCss = css.slice(css.indexOf('/* API price equivalence'));
  assert.ok(!/overflow-x\s*:\s*auto/.test(priceCss), 'the price block declares no horizontal scroller');
  // The static skeleton lives in index.html; the group headings stay stable across polls.
  assert.ok(page.includes('data-price-group="month"') && page.includes('data-price-group="alltime"'), 'index.html has a stable card container per group');
  assert.ok(page.includes('data-i18n="price.month"') && page.includes('data-i18n="price.allTime"'), 'the group headings are static i18n text, not rebuilt markup');
  // The scroller strings left both dictionaries, the rate caption entered both.
  for (const lang of ['en', 'ja']) {
    assert.ok(!Object.hasOwn(MESSAGES[lang], 'price.tableScroll'), `${lang} no longer promises a horizontal scroller`);
    assert.ok(Object.hasOwn(MESSAGES[lang], 'price.ratesCaption'), `${lang} names the rate table for screen readers`);
  }
  setLanguage('ja');
  assert.equal(t('price.ratesCaption'), '100万トークンあたりの単価');
  setLanguage('en');
  assert.equal(t('price.ratesCaption'), 'Rates per 1M tokens');
});

// The ledger groups model names case-sensitively and stores raw model_name strings, so the DOM identity key
// must preserve every distinct exact string (no trim, no case fold). Case folding stays in priceFor, which
// maps prices, not DOM identity.
test('priceCardKey gives every distinct exact model string a distinct key and shares one missing sentinel', () => {
  assert.equal(priceCardKey('GLM-5.3-Flash-FP8'), 'model:GLM-5.3-Flash-FP8', 'the key preserves the exact model string');
  assert.equal(priceCardKey('GLM-5.3-Flash-FP8'), priceCardKey('GLM-5.3-Flash-FP8'), 'the same exact string keeps the same key, so cards stay stable across polls');
  assert.notEqual(priceCardKey('GLM-5.3-Flash-FP8'), priceCardKey('glm-5.3-flash-fp8'), 'case-different model names get distinct keys, so their cards cannot collide');
  assert.notEqual(priceCardKey('GLM-5.3-Flash-FP8'), priceCardKey(' GLM-5.3-Flash-FP8 '), 'whitespace-different model names get distinct keys, so their cards cannot collide');
  assert.equal(priceCardKey(null), 'missing:', 'null shares the missing sentinel');
  assert.equal(priceCardKey(null), priceCardKey(undefined), 'null and undefined share the missing sentinel');
  assert.notEqual(priceCardKey(''), 'missing:', 'a literal empty string is not null, so it gets its own key');
});

test('app.js keys its price cards with the shared priceCardKey helper', () => {
  const app = readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.match(app, /key:priceCardKey\(modelName\)/, 'priceCardData calls priceCardKey(modelName), not a local reimplementation');
  assert.ok(!/const priceKey/.test(app), 'no local key helper remains in app.js');
});
