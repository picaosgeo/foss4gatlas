/* ============================================================================
 * FOSS4G Atlas — MapLibre GL JS 実装
 *
 * data/foss4g_usage.geojson（WGS84 / EPSG:4326、Point 230 件）を読み込み、
 * 都市 × 分類で集約して MapLibre の circle レイヤーとして描画する。
 *
 * 設計方針
 *  - 色は必ず CSS カスタムプロパティから読む（getComputedStyle）。
 *    ライト／ダークのトークンが一箇所で管理され、テーマ切替で再着色できる。
 *  - 同一都市に複数分類がある場合、分類ごとに別レイヤーを作り
 *    circle-translate（レイヤー単位の固定ピクセルオフセット）で放射状にずらす。
 *    データ駆動オフセットが不要なので式が単純で、描画も速い。
 *  - ベースマップは 3 モード。既定は 'flat'（ローカルの陸地ポリゴンのみ／
 *    通信不要／Artifact と同じ配色）。
 * ========================================================================= */

'use strict';

/* ---------------------------------------------------------------- 設定 --- */

const CONFIG = {
  data:      'data/foss4g_usage.geojson',
  landData:  'data/world_land.geojson',   // basemap 'flat' 用

  /* 'flat'   : 陸地ポリゴン＋経緯線のみ。通信不要。Artifact と同じ見た目。
     'vector' : CARTO のキー不要ベクタースタイル（Positron / Dark Matter）。
     'raster' : 任意のラスタタイル（下の raster.tiles を自分の配信元に差し替える）。 */
  basemap: 'flat',

  vector: {
    light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
    dark:  'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
  },
  raster: {
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    tileSize: 256,
    maxzoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  },

  initial: { center: [20, 26], zoom: 1.35 },
  views: [
    { label: '全世界',       bounds: [[-170, -48], [178, 70]] },
    { label: 'ヨーロッパ',   bounds: [[-11, 36],  [30, 61]] },
    { label: '日本・アジア', bounds: [[95, 5],    [147, 46]] },
    { label: '南北アメリカ', bounds: [[-125, -35],[-45, 52]] }
  ]
};

/* 分類の定義。key は GeoJSON properties.category と一致させる。 */
const CATS = [
  { key: 'origin',   label: '語源・初出',       token: '--c-origin' },
  { key: 'global',   label: '世界大会',         token: '--c-global' },
  { key: 'regional', label: '地域大会',         token: '--c-regional' },
  { key: 'national', label: '国別・国内',       token: '--c-national' },
  { key: 'paper',    label: '論文・出版物',     token: '--c-paper' },
  { key: 'product',  label: 'プロダクト・組織', token: '--c-product' }
];
const CAT_LABEL = Object.fromEntries(CATS.map(c => [c.key, c.label]));

/* 分類ごとの固定オフセット（px）。6分類を正六角形状に配置する。 */
const SPREAD = 9;
const OFFSET = Object.fromEntries(CATS.map((c, i) => {
  const a = -Math.PI / 2 + i * 2 * Math.PI / CATS.length;
  return [c.key, [+(Math.cos(a) * SPREAD).toFixed(2), +(Math.sin(a) * SPREAD).toFixed(2)]];
}));

const SRC_DOTS = 'foss4g-dots';
const SRC_LAND = 'world-land';
const SRC_GRAT = 'graticule';
const layerId = key => `dots-${key}`;

/* ------------------------------------------------------------ ユーティリティ --- */

const $  = sel => document.querySelector(sel);
const esc = s => String(s).replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** CSS カスタムプロパティを実際の色文字列として取得する。 */
function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
const catColor = key => token(CATS.find(c => c.key === key).token);

/** 現在の実効テーマ（'light' | 'dark'）。data-theme 未指定なら OS 設定に従う。 */
function effectiveTheme() {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'dark' || attr === 'light') return attr;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/* -------------------------------------------------------------- 状態 --- */

const state = {
  records: [],            // GeoJSON features の properties 配列
  features: [],           // 元 features（座標つき）
  hidden: new Set(),      // 非表示の分類 key
  year: null,             // 絞り込み中の年（null = 全期間）
  query: '',
  sort: { col: 'year', dir: 1 }
};

let map = null;

/* ============================================================ 起動 ======= */

init().catch(showFatal);

async function init() {
  const fc = await fetchJson(CONFIG.data);
  if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    throw new Error('GeoJSON の形式が想定と異なります（FeatureCollection ではありません）');
  }

  state.features = fc.features.filter(f =>
    f.geometry && f.geometry.type === 'Point' &&
    Number.isFinite(f.geometry.coordinates[0]) &&
    Number.isFinite(f.geometry.coordinates[1]));
  state.records = state.features.map(f => ({
    ...f.properties,
    lon: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1]
  }));

  if (!state.records.length) throw new Error('有効な Point フィーチャが 0 件でした');

  buildLegend();
  buildViews();
  buildTimeline();
  bindTable();
  bindTheme();

  await buildMap();
  render();
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url} を取得できません（HTTP ${res.status}）`);
  return res.json();
}

function showFatal(err) {
  console.error(err);
  $('#loading').hidden = true;
  const box = $('#err');
  box.hidden = false;
  box.innerHTML =
    `<div><b>データを読み込めませんでした。</b><br>${esc(err.message)}<br><br>` +
    `<code>file://</code> で直接開くと fetch がブロックされます。` +
    `フォルダ内で <code>python3 -m http.server 8000</code> を実行し、` +
    `<code>http://localhost:8000/</code> を開いてください。</div>`;
}

/* ====================================================== 地図の構築 ======= */

async function buildMap() {
  const style = await buildStyle();

  map = new maplibregl.Map({
    container: 'map',
    style,
    center: CONFIG.initial.center,
    zoom: CONFIG.initial.zoom,
    minZoom: 0.8,
    maxZoom: 12,
    attributionControl: false,
    /* 経度方向のループを止め、正距円筒に近い一枚地図として扱う */
    renderWorldCopies: false,
    dragRotate: false,
    pitchWithRotate: false
  });
  map.touchZoomRotate.disableRotation();

  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 96, unit: 'metric' }), 'bottom-right');
  map.addControl(new maplibregl.AttributionControl({
    compact: true,
    customAttribution:
      'FOSS4G Atlas — 出典は各記録の source_url 参照 / 陸地: Natural Earth 110m'
  }), 'bottom-right');

  await new Promise(res => map.on('load', res));
  addOverlay();
  bindMapInteraction();
  $('#loading').hidden = true;
  fitView(0);
}

/** basemap モードに応じた style spec / URL を返す。 */
async function buildStyle() {
  const dark = effectiveTheme() === 'dark';

  if (CONFIG.basemap === 'vector') {
    return dark ? CONFIG.vector.dark : CONFIG.vector.light;
  }

  if (CONFIG.basemap === 'raster') {
    return {
      version: 8,
      sources: {
        base: {
          type: 'raster',
          tiles: CONFIG.raster.tiles,
          tileSize: CONFIG.raster.tileSize,
          maxzoom: CONFIG.raster.maxzoom,
          attribution: CONFIG.raster.attribution
        }
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': token('--ocean') } },
        {
          id: 'base', type: 'raster', source: 'base',
          /* ダークテーマではタイルを沈ませて記号を前に出す */
          paint: dark
            ? { 'raster-opacity': 0.5, 'raster-saturation': -0.7, 'raster-brightness-max': 0.72 }
            : { 'raster-opacity': 0.85, 'raster-saturation': -0.55 }
        }
      ]
    };
  }

  /* 既定 'flat' — ローカルの陸地ポリゴン＋経緯線だけの自作スタイル */
  const land = await fetchJson(CONFIG.landData);
  return {
    version: 8,
    sources: {
      [SRC_LAND]: { type: 'geojson', data: land },
      [SRC_GRAT]: { type: 'geojson', data: graticule(30, 20) }
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': token('--ocean') } },
      {
        id: 'land-fill', type: 'fill', source: SRC_LAND,
        paint: { 'fill-color': token('--land') }
      },
      {
        id: 'land-line', type: 'line', source: SRC_LAND,
        paint: {
          'line-color': token('--land-line'),
          'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.6, 6, 1.4]
        }
      },
      {
        id: 'grat', type: 'line', source: SRC_GRAT,
        paint: {
          'line-color': token('--grat'),
          'line-width': ['case', ['==', ['get', 'kind'], 'equator'], 1.4, 0.7],
          'line-dasharray': ['literal', [2, 5]]
        }
      }
    ]
  };
}

/** 経緯線を LineString の FeatureCollection として生成する。 */
function graticule(stepLon, stepLat) {
  const features = [];
  for (let lon = -180; lon <= 180; lon += stepLon) {
    const line = [];
    for (let lat = -84; lat <= 84; lat += 4) line.push([lon, lat]);
    features.push({ type: 'Feature', properties: { kind: 'meridian' },
      geometry: { type: 'LineString', coordinates: line } });
  }
  for (let lat = -80; lat <= 80; lat += stepLat) {
    const line = [];
    for (let lon = -180; lon <= 180; lon += 5) line.push([lon, lat]);
    features.push({ type: 'Feature', properties: { kind: lat === 0 ? 'equator' : 'parallel' },
      geometry: { type: 'LineString', coordinates: line } });
  }
  return { type: 'FeatureCollection', features };
}

/* -------------------------------------------- 記録レイヤー（分類ごと） --- */

function addOverlay() {
  /* generateId: true — feature-state（ホバー強調）で使う id を自動採番させる */
  map.addSource(SRC_DOTS, { type: 'geojson', data: dotsGeoJSON(), generateId: true });

  CATS.forEach(c => {
    map.addLayer({
      id: layerId(c.key),
      type: 'circle',
      source: SRC_DOTS,
      filter: ['==', ['get', 'category'], c.key],
      paint: {
        /* 件数 1→4.6px, 12→13px 程度。面積が件数に比例するよう平方根で効かせる */
        'circle-radius': [
          'interpolate', ['linear'], ['zoom'],
          1, ['interpolate', ['linear'], ['sqrt', ['get', 'count']], 1, 4.2, 3.5, 11],
          6, ['interpolate', ['linear'], ['sqrt', ['get', 'count']], 1, 7,   3.5, 18]
        ],
        'circle-color': catColor(c.key),
        'circle-opacity': 0.72,
        'circle-stroke-color': catColor(c.key),
        'circle-stroke-width': ['case', ['boolean', ['feature-state', 'hover'], false], 2.4, 1.2],
        'circle-stroke-opacity': 1,
        /* 同一都市で分類が重ならないよう、レイヤー単位でずらす */
        'circle-translate': OFFSET[c.key],
        'circle-translate-anchor': 'viewport'
      }
    });
  });
}

/** 元データを 都市×分類 で集約した FeatureCollection を作る。 */
function dotsGeoJSON() {
  const bucket = new Map();
  state.records.forEach(r => {
    if (state.hidden.has(r.category)) return;
    if (state.year !== null && r.year !== state.year) return;
    const key = `${r.city}|${r.country}|${r.category}`;
    if (!bucket.has(key)) {
      bucket.set(key, {
        type: 'Feature',
        properties: {
          key, category: r.category, city: r.city, country: r.country,
          count: 0, years: [], names: []
        },
        geometry: { type: 'Point', coordinates: [r.lon, r.lat] }
      });
    }
    const f = bucket.get(key);
    f.properties.count++;
    f.properties.years.push(r.year);
    f.properties.names.push(`${r.year} ${r.name}`);
  });

  const features = [...bucket.values()];
  features.forEach(f => {
    const ys = f.properties.years;
    f.properties.yearMin = Math.min(...ys);
    f.properties.yearMax = Math.max(...ys);
    /* 配列は式やツールチップで扱いにくいので落とす（詳細は state.records から引く） */
    delete f.properties.years;
    delete f.properties.names;
  });
  /* 大きい円を先に描いて小さい円が隠れないようにする */
  features.sort((a, b) => b.properties.count - a.properties.count);
  return { type: 'FeatureCollection', features };
}

function refreshDots() {
  const src = map && map.getSource(SRC_DOTS);
  if (src) src.setData(dotsGeoJSON());
}

/* --------------------------------------------------- ホバーとクリック --- */

function bindMapInteraction() {
  const tip = $('#tip');
  const box = $('#mapbox');
  let hoverKey = null;

  const detailFor = p => {
    const rs = state.records
      .filter(r => r.city === p.city && r.country === p.country && r.category === p.category)
      .filter(r => state.year === null || r.year === state.year)
      .sort((a, b) => a.year - b.year);
    const head = rs.slice(0, 4).map(r => `${r.year}　${esc(r.name)}`).join('<br>');
    const more = rs.length > 4 ? `<br>ほか ${rs.length - 4} 件` : '';
    return `<div class="t">${esc(p.city)}, ${esc(p.country)}</div>` +
      `<div class="m">${CAT_LABEL[p.category]} · ${p.count}件 · ` +
      `${p.yearMin === p.yearMax ? p.yearMin : p.yearMin + '–' + p.yearMax}</div>` +
      `<div style="margin-top:6px">${head}${more}</div>`;
  };

  CATS.forEach(c => {
    const id = layerId(c.key);

    map.on('mousemove', id, e => {
      const f = e.features[0];
      if (!f) return;
      map.getCanvas().style.cursor = 'pointer';
      if (hoverKey !== null && hoverKey !== f.id) {
        map.setFeatureState({ source: SRC_DOTS, id: hoverKey }, { hover: false });
      }
      hoverKey = f.id;
      map.setFeatureState({ source: SRC_DOTS, id: hoverKey }, { hover: true });

      tip.innerHTML = detailFor(f.properties);
      tip.classList.add('on');
      const w = box.clientWidth, h = box.clientHeight;
      let x = e.point.x + 16, y = e.point.y + 14;
      if (x + 282 > w) x = e.point.x - 294;
      if (y + 132 > h) y = Math.max(4, e.point.y - 142);
      tip.style.left = x + 'px';
      tip.style.top = y + 'px';
    });

    map.on('mouseleave', id, () => {
      map.getCanvas().style.cursor = '';
      if (hoverKey !== null) {
        map.setFeatureState({ source: SRC_DOTS, id: hoverKey }, { hover: false });
        hoverKey = null;
      }
      tip.classList.remove('on');
    });

    /* クリック → 一覧をその都市に絞り込んでスクロール */
    map.on('click', id, e => {
      const p = e.features[0].properties;
      $('#q').value = p.city;
      state.query = p.city.toLowerCase();
      render();
      $('#table-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

/* ======================================================== UI 構築 ======= */

function buildLegend() {
  $('#legend').innerHTML = CATS.map(c => {
    const n = state.records.filter(r => r.category === c.key).length;
    return `<button class="lg" type="button" data-cat="${c.key}" aria-pressed="true">
      <span class="dot" style="background:var(${c.token})"></span>${c.label}
      <span class="n">${n}</span></button>`;
  }).join('');

  $('#legend').addEventListener('click', e => {
    const b = e.target.closest('.lg');
    if (!b) return;
    const key = b.dataset.cat;
    if (state.hidden.has(key)) { state.hidden.delete(key); b.setAttribute('aria-pressed', 'true'); }
    else { state.hidden.add(key); b.setAttribute('aria-pressed', 'false'); }
    if (map) map.setLayoutProperty(layerId(key), 'visibility',
      state.hidden.has(key) ? 'none' : 'visible');
    render();
  });
}

function buildViews() {
  $('#views').innerHTML = CONFIG.views.map((v, i) =>
    `<button type="button" data-i="${i}" aria-pressed="${i === 0}">${v.label}</button>`).join('');
  $('#views').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b) fitView(+b.dataset.i);
  });
}

function fitView(i) {
  [...document.querySelectorAll('#views button')]
    .forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.i === i)));
  if (map) map.fitBounds(CONFIG.views[i].bounds, { padding: 34, duration: 620 });
}

function buildTimeline() {
  const years = state.records.map(r => r.year);
  const y0 = Math.min(...years), y1 = Math.max(...years);
  const span = [];
  for (let y = y0; y <= y1; y++) span.push(y);

  const total = y => state.records.filter(r => r.year === y).length;
  const peak = Math.max(...span.map(total)) || 1;

  $('#bars').innerHTML = span.map(y => {
    const segs = CATS.map(c => {
      const n = state.records.filter(r => r.year === y && r.category === c.key).length;
      if (!n) return '';
      return `<span class="sg" style="height:${(n / peak * 78).toFixed(1)}px;` +
        `background:var(${c.token})" title="${c.label} ${n}件"></span>`;
    }).join('');
    return `<button class="yr" type="button" data-y="${y}" aria-pressed="false"
      aria-label="${y}年 ${total(y)}件"><span class="col">${segs}</span></button>`;
  }).join('');

  $('#yraxis').innerHTML = span.map(y =>
    `<span>${(y % 5 === 0 || y === y0 || y === y1) ? '’' + String(y).slice(2) : ''}</span>`).join('');

  $('#bars').addEventListener('click', e => {
    const b = e.target.closest('.yr');
    if (!b) return;
    const y = +b.dataset.y;
    state.year = state.year === y ? null : y;
    [...document.querySelectorAll('.yr')]
      .forEach(o => o.setAttribute('aria-pressed', String(+o.dataset.y === state.year)));
    render();
  });
}

function bindTable() {
  $('#q').addEventListener('input', e => {
    state.query = e.target.value.trim().toLowerCase();
    render();
  });
  $('#thead').addEventListener('click', e => {
    const th = e.target.closest('th[data-col]');
    if (!th) return;
    const col = th.dataset.col;
    state.sort = { col, dir: state.sort.col === col ? -state.sort.dir : 1 };
    render();
  });
  /* 行クリック → その地点へ寄る */
  $('#tbody').addEventListener('click', e => {
    const tr = e.target.closest('tr[data-lon]');
    if (!tr || e.target.closest('a')) return;
    if (map) map.easeTo({ center: [+tr.dataset.lon, +tr.dataset.lat], zoom: 5.4, duration: 700 });
    $('#mapcard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

/* テーマ切替：スタイルを差し替えたあとオーバーレイを再構築する */
function bindTheme() {
  $('#theme').addEventListener('click', async e => {
    const b = e.target.closest('button');
    if (!b) return;
    const mode = b.dataset.theme;
    if (mode === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
    [...document.querySelectorAll('#theme button')]
      .forEach(x => x.setAttribute('aria-pressed', String(x.dataset.theme === mode)));
    await restyle();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!document.documentElement.hasAttribute('data-theme')) restyle();
  });
}

async function restyle() {
  if (!map) return;
  const style = await buildStyle();
  map.setStyle(style, { diff: false });
  await new Promise(res => map.once('styledata', res));
  addOverlay();
  bindMapInteraction();
  state.hidden.forEach(k => map.setLayoutProperty(layerId(k), 'visibility', 'none'));
}

/* ========================================================= 描画 ========= */

function filtered() {
  return state.records.filter(r => {
    if (state.hidden.has(r.category)) return false;
    if (state.year !== null && r.year !== state.year) return false;
    if (state.query) {
      const hay = `${r.name} ${r.city} ${r.country} ${r.description} ${r.year}`.toLowerCase();
      if (!hay.includes(state.query)) return false;
    }
    return true;
  });
}

function sortRows(rows) {
  const { col, dir } = state.sort;
  const get = r => col === 'year' ? r.year
    : col === 'category' ? CATS.findIndex(c => c.key === r.category)
    : col === 'place' ? `${r.country} ${r.city}`
    : r.name;
  return [...rows].sort((a, b) => {
    const x = get(a), y = get(b);
    return (x > y ? 1 : x < y ? -1 : a.year - b.year) * dir;
  });
}

function render() {
  refreshDots();

  const rows = sortRows(filtered());
  const cities = new Set(rows.map(r => `${r.city}|${r.country}`)).size;
  const countries = new Set(rows.map(r => r.country)).size;

  $('#ebn').textContent = `${rows.length} records`;
  $('#stats').innerHTML = [
    [rows.length, '使用記録'],
    [countries, 'の国・地域'],
    [cities, '都市'],
    [rows.length ? `${Math.min(...rows.map(r => r.year))}–${Math.max(...rows.map(r => r.year))}` : '—', '対象年'],
    [rows.filter(r => r.category === 'global').length, '世界大会']
  ].map(([v, k]) => `<div class="stat"><span class="v">${v}</span><span class="k">${k}</span></div>`).join('');

  $('#cnt').textContent =
    `${rows.length} / ${state.records.length} 件` + (state.year !== null ? ` · ${state.year}年` : '');

  $('#tbody').innerHTML = rows.map(r => {
    let host = r.source_url;
    try { host = new URL(r.source_url).hostname.replace(/^www\./, ''); } catch (_) {}
    return `<tr data-lon="${r.lon}" data-lat="${r.lat}">
      <td class="y">${r.year}${r.when ? `<div style="font-size:10px;color:var(--ink-3)">${esc(r.when)}</div>` : ''}</td>
      <td><span class="chip" style="color:var(${CATS.find(c => c.key === r.category).token})">
        <span class="dot"></span>${CAT_LABEL[r.category]}</span></td>
      <td class="nm"><b>${esc(r.name)}</b>${r.confidence === 'unverified' ? '<span class="flag">要確認</span>' : ''}
        <div class="d">${esc(r.description)}</div></td>
      <td class="pl">${esc(r.city)}<div style="font-size:11px;color:var(--ink-3)">${esc(r.country)}</div></td>
      <td class="co">${r.lat.toFixed(4)}<br>${r.lon.toFixed(4)}</td>
      <td class="src"><a href="${esc(r.source_url)}" target="_blank" rel="noopener">${esc(host)}</a></td>
    </tr>`;
  }).join('');

  $('#empty').hidden = rows.length > 0;

  [...document.querySelectorAll('#thead th[data-col] .ar')].forEach(el => {
    const col = el.closest('th').dataset.col;
    el.textContent = state.sort.col === col ? (state.sort.dir > 0 ? '▲' : '▼') : '';
  });
}
