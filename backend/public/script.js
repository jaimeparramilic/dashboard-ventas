// public/script.js
const api = window.location.origin;

/* =================== Estado global =================== */
let mapa, chart;
let layerPoligonos = null;
let geoDeptos = null;   // GeoJSON ADM1 (departamentos)
let geoCiudades = null; // GeoJSON ADM2 (municipios/ciudades)
let nivelMapa = 'departamento'; // controlado desde index.html
let currentNivel = null; // para saber si podemos reutilizar la capa y solo repintar

let DETECTED_DEPT_PROP = null;
let DETECTED_CITY_PROP = null;
let _mapRenderSeq = 0; // token para descartar renders viejos

/* Loaders / Abort por sección */
const aborts  = { kpis: null, series: null, mapa: null };
const loaders = { kpis: null, series: null, mapa: null };

// Versión de datos para invalidar caché del navegador cuando subas nuevos archivos
const GEO_VERSION = "v1";         // si reemplazas los .geojson, súbelo a "v2"
const LSCACHE_DAYS = 30;          // persistencia en localStorage
const LSCACHE_TTL = LSCACHE_DAYS * 24 * 60 * 60 * 1000;

function lsGetJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !obj.t || !obj.v) return null;
    if (obj.v !== GEO_VERSION) return null;
    if (Date.now() - obj.t > LSCACHE_TTL) return null;
    return obj.data ?? null;
  } catch { return null; }
}
function lsSetJSON(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ v: GEO_VERSION, t: Date.now(), data }));
  } catch {}
}

function augmentGeo(geo, level) {
  const feats = geo?.features || [];
  for (const f of feats) {
    const p = f.properties || (f.properties = {});
    // Usa las funciones de nombre ya existentes + canon*
    const dRaw = nombreDeptoFromFeature(f);
    const cRaw = nombreCiudadFromFeature(f);
    const dCanon = canonDept(dRaw);
    const cCanon = canonCity(cRaw);

    p.__canon_dpto = dCanon;
    p.__canon_city = cCanon;
    p.__canon_dpto_for_city = (cCanon === 'bogota' || cCanon === 'bogota d c' || cCanon === 'bogota dc')
      ? 'bogota dc'
      : dCanon;
  }
}


/* Cache simple con TTL (memoria) */
const cache = new Map();
const cacheKey = (url, body) => (body ? `${url}|${JSON.stringify(body)}` : url);

async function cachedFetch(url, opts = {}, ttlMs = 60_000) {
  const key = cacheKey(url, opts.body);
  const now = Date.now();
  const entry = cache.get(key);
  if (entry && (now - entry.t) < ttlMs) {
    return new Response(new Blob([entry.payload]), { status: 200 });
  }
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let lastErr;

  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(url, opts);
      if (!res.ok) {
        const txt = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(`HTTP ${res.status} en ${url} — ${txt.slice(0, 120)}...`);
      }
      const text = await res.clone().text();
      cache.set(key, { t: now, payload: text });
      return new Response(new Blob([text]), { status: 200 });
    } catch (e) {
      // ⛔ si es un aborto, no reintentes ni loguees ruido
      if (e?.name === 'AbortError' || (opts?.signal && opts.signal.aborted)) {
        throw e;
      }
      lastErr = e;
      if (i < 4) {
        const base = 300 * Math.pow(2, i);
        const jitter = Math.floor(Math.random() * 150);
        await sleep(base + jitter);
      }
    }
  }
  throw lastErr;
}


/* =================== Rutas GeoJSON (GCS) =================== */
// AJUSTA el nombre del bucket a tu valor real
const GCS_BUCKET = "ventas-geo-bubbly-vine-471620-h1";
const URL_DEPTOS   = `https://storage.googleapis.com/${GCS_BUCKET}/departamentos.geojson`;
const URL_CIUDADES = `https://storage.googleapis.com/${GCS_BUCKET}/ciudades.geojson`;

// --- Canonicalización igual que el backend ---
// --- Canonicalización igual que el backend ---
function canonBase(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[.,()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function canonDept(name) {
  return canonBase(name)
    .replace(/^departamento del? /, '')
    .replace(/^dpto del? /, '')
    .replace(/ departamento$/, '')
    .replace(/ depto$/, '');
}
function canonCity(name) {
  return canonBase(name)
    .replace(/^municipio de /, '')
    .replace(/^ciudad de /, '');
}
function isBogotaCityCanon(c) {
  return c === 'bogota' || c === 'bogota d c' || c === 'bogota dc';
}

// 🔽 AÑADE ESTO ABAJO:
window.canonBase = canonBase;
window.canonDept = canonDept;
window.canonCity = canonCity;
window.isBogotaCityCanon = isBogotaCityCanon;


/* =================== Helpers base =================== */
const filtrosKeys = ["departamento","ciudad","macrocategoria","categoria","subcategoria","segmento","marca"];

const normalize = (str) => {
  if (str === null || str === undefined) return "";
  return String(str)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
};

const debounce = (fn, wait = 300) => {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
};

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null && obj[k] !== "") return obj[k];
  }
  return undefined;
}

/* =================== Loader helpers =================== */
function makeOverlayWithProgress(target, { dark = true } = {}) {
  const overlay = document.createElement("div");
  Object.assign(overlay.style, {
    position: "absolute",
    inset: "0",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "column",
    gap: "10px",
    background: dark ? "rgba(0,0,0,0.45)" : "transparent",
    zIndex: 999
  });
  const spinner = document.createElement("div");
  spinner.className = "spinner-border text-light";
  spinner.setAttribute("role", "status");
  spinner.style.width = "2.25rem";
  spinner.style.height = "2.25rem";
  const label = document.createElement("div");
  label.style.fontSize = "0.95rem";
  label.style.opacity = "0.9";
  label.textContent = "Cargando…";
  overlay.appendChild(spinner);
  overlay.appendChild(label);

  const parent = target;
  const prevPos = getComputedStyle(parent).position;
  if (prevPos === "static" || !prevPos) parent.style.position = "relative";

  return {
    show(text = "Cargando…") { label.textContent = text; if (!overlay.parentNode) parent.appendChild(overlay); },
    setText(text) { label.textContent = text; },
    setProgress(p) { label.textContent = `Dibujando mapa… ${Math.round(p*100)}%`; },
    hide() { try { parent.removeChild(overlay); } catch {} }
  };
}

function setKPILoading(on = true) {
  const ids = ["kpi-ventas", "kpi-unidades", "kpi-ticket", "kpi-categorias"];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (on) {
      el.dataset.prev = el.textContent;
      el.innerHTML = '<span class="spinner-border spinner-border-sm text-light"></span>';
    } else {
      if (el.dataset.prev !== undefined) delete el.dataset.prev;
    }
  });
}

/* =================== GeoJSON (cacheado) =================== */
async function cargarGeoJSON(nivelWanted = 'departamento') {
  const needDept = (nivelWanted === 'departamento' && !geoDeptos);
  const needCity = (nivelWanted === 'ciudad'        && !geoCiudades);
  if (!needDept && !needCity) return;

  async function fetchAndMaybeTopo(kind, url) {
    const lsKey = `geo:${kind}`;
    const fromLS = lsGetJSON(lsKey);
    if (fromLS) return fromLS;

    const res = await cachedFetch(url, {}, 24 * 60 * 60 * 1000);
    const text = await res.text();

    let data = JSON.parse(text);
    if (data && data.type === 'Topology' && window.topojson && typeof window.topojson.feature === 'function') {
      const objName = Object.keys(data.objects)[0];
      data = window.topojson.feature(data, data.objects[objName]);
    }
    lsSetJSON(lsKey, data);
    return data;
  }

  if (needDept) {
    geoDeptos = await fetchAndMaybeTopo('dept', URL_DEPTOS);
    detectPropNames(geoDeptos, 'departamento');  // <— NUEVO
    augmentGeo(geoDeptos, 'departamento');
  }
  if (needCity) {
    geoCiudades = await fetchAndMaybeTopo('city', URL_CIUDADES);
    detectPropNames(geoCiudades, 'ciudad');      // <— NUEVO
    augmentGeo(geoCiudades, 'ciudad');
  }
}


/* =================== Filtros =================== */
async function cargarFiltros() {
  const res = await cachedFetch(`${api}/filtros`, {}, 10*60*1000);
  const data = await res.json();

  filtrosKeys.forEach((key) => {
    const select = document.getElementById(key);
    if (!select) return;
    const prev = select.value;
    select.innerHTML = "<option value=''>Todas</option>";
    (data[key] || []).forEach((val) => {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = val;
      select.appendChild(opt);
    });
    if ([...select.options].some(o => o.value === prev)) select.value = prev;
  });
}

function getFiltros() {
  const filtros = {};
  filtrosKeys.forEach((key) => {
    const el = document.getElementById(key);
    if (el && el.value) filtros[key] = el.value;
  });
  return filtros;
}

function getQueryFromFiltros(extra = {}) {
  const filtros = getFiltros();
  const params = new URLSearchParams({ ...filtros, ...extra });
  return params.toString();
}

function populateSelect(select, values, previousValue) {
  if (!select) return;
  const prev = previousValue ?? select.value;
  select.innerHTML = "<option value=''>Todas</option>";
  (values || []).forEach((val) => {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = val;
    select.appendChild(opt);
  });
  // preserva selección si todavía existe
  if ([...select.options].some(o => o.value === prev)) {
    select.value = prev;
  } else {
    select.value = "";
  }
  // deshabilita si no hay opciones reales
  select.disabled = select.options.length <= 1;
}

/* =================== KPIs =================== */
async function cargarKPIs() {
  if (aborts.kpis) aborts.kpis.abort();
  aborts.kpis = new AbortController();
  const signal = aborts.kpis.signal;

  try {
    setKPILoading(true);
    const query = getQueryFromFiltros();
    const res = await cachedFetch(`${api}/kpis?${query}`, { signal }, 30*1000);
    const data = await res.json();

    const elV = document.getElementById("kpi-ventas");
    const elU = document.getElementById("kpi-unidades");
    const elT = document.getElementById("kpi-ticket");
    const elC = document.getElementById("kpi-categorias");

    if (elV) elV.textContent = "$" + Math.round(data.total_ventas || 0).toLocaleString();
    if (elU) elU.textContent = (data.unidades_vendidas || 0).toLocaleString();
    if (elT) elT.textContent = "$" + Math.round(data.ticket_promedio || 0).toLocaleString();
    if (elC) elC.textContent = data.categorias_activas ?? "--";
  } catch (e) {
    if (e.name !== "AbortError") console.error("KPIs error:", e);
  } finally {
    setKPILoading(false);
    aborts.kpis = null;
  }
}

/* =================== Serie temporal (mensual) =================== */
async function cargarGrafico() {
  const canvas = document.getElementById("chartVentas");
  if (!canvas) return;
  if (!loaders.series) loaders.series = makeOverlayWithProgress(canvas.parentElement, { dark: true });

  if (aborts.series) aborts.series.abort();
  aborts.series = new AbortController();
  const signal = aborts.series.signal;

  try {
    loaders.series.show("Cargando serie…");
    const query = getQueryFromFiltros();
    const res = await cachedFetch(`${api}/ventas/series?${query}`, { signal }, 30*1000);
    const raw = await res.json();

    const agregados = {};
    (raw || []).forEach((d) => {
      const mes = (d.fecha || "").slice(0, 7); // YYYY-MM
      if (!mes) return;
      agregados[mes] = (agregados[mes] || 0) + (Number(d.total) || 0);
    });

    const labelsISO = Object.keys(agregados).sort();
    const valores = labelsISO.map((k) => agregados[k]);
    const labelsBonitos = labelsISO.map((ym) => {
      const date = new Date(`${ym}-01T00:00:00`);
      return date.toLocaleDateString("es-CO", { month: "long", year: "numeric" });
    });

    canvas.height = 420; // doble altura

    const ctx = canvas.getContext("2d");
    if (chart && typeof chart.destroy === 'function') chart.destroy();
    if (window.Chart) {
      chart = new Chart(ctx, {
        type: "line",
        data: {
          labels: labelsBonitos,
          datasets: [{
            label: "Ventas mensuales",
            data: valores,
            borderColor: "#ffffff",
            backgroundColor: "rgba(255,255,255,0.15)",
            fill: true,
            tension: 0.3,
            borderWidth: 2,
            pointRadius: 3,
            pointHoverRadius: 5,
          }],
        },
        options: {
          responsive: true,
          animation: { duration: 350 },
          scales: {
            x: { ticks: { color: "#fff" }, grid: { color: "rgba(255,255,255,0.08)" } },
            y: {
              beginAtZero: true,
              ticks: { color: "#fff", callback: (v) => "$" + Number(v).toLocaleString() },
              grid: { color: "rgba(255,255,255,0.08)" },
            },
          },
          plugins: {
            legend: { labels: { color: "#fff" } },
            tooltip: { callbacks: { label: (ctx) => "Ventas: $" + Number(ctx.parsed.y).toLocaleString() } },
          },
        },
      });
    }
  } catch (e) {
    if (e.name !== "AbortError") console.error("Serie error:", e);
  } finally {
    loaders.series.hide();
    aborts.series = null;
  }
}

/* =================== Mapa (coropletas) =================== */
let canvasRenderer = null;
let hoverTip = null;

function initMapaSiNecesario() {
  if (mapa) return;

  const mapDiv = document.getElementById("map");
  if (!mapDiv) return;

  mapDiv.style.background = "#000";
  mapa = L.map("map", {
    minZoom: 4,
    zoom: 5,
    center: [4.6, -74.1],
    zoomControl: true,
    preferCanvas: true,          // vector por canvas
    zoomAnimation: false,        // menos trabajo en zoom
    fadeAnimation: false,        // menos repaints
    inertia: true,
    wheelDebounceTime: 30,
    wheelPxPerZoomLevel: 120
  });

  // Renderer Canvas compartido para todas las capas vectoriales
  canvasRenderer = L.canvas({ padding: 0.5 });

  // CSS de transición suave
  if (!document.getElementById("leaflet-style-smooth")) {
    const s = document.createElement("style");
    s.id = "leaflet-style-smooth";
    s.textContent = `
      .leaflet-interactive, .poly-glow {
        transition: fill 160ms ease, fill-opacity 160ms ease, stroke 120ms ease, stroke-width 120ms ease;
      }
      .leaflet-tooltip.hover-tip {
        background: rgba(17,24,39,.92);
        color: #fff;
        border: 0;
        border-radius: 10px;
        box-shadow: 0 8px 24px rgba(0,0,0,.35);
        padding: 6px 8px;
      }
    `;
    document.head.appendChild(s);
  }

  // Tooltip único (no uno por feature)
  hoverTip = L.tooltip({ className: 'hover-tip', opacity: 0.95, sticky: true });

  if (!loaders.mapa) loaders.mapa = makeOverlayWithProgress(mapDiv, { dark: true });
  loaders.mapa.show("Cargando mapa…");
}
let layerDeptos = null;
let layerCiudades = null;

function attachLightEvents(feature, layer, nivel, valores, maxVal) {
  layer.on("mousemove", (e) => {
    const dDisp = nombreDeptoFromFeature(feature) || "—";
    const cDisp = nombreCiudadFromFeature(feature) || "—";
    const p = feature.properties || {};
    const dCanon = p.__canon_dpto ?? canonDept(dDisp);
    const cCanon = p.__canon_city ?? canonCity(cDisp);
    const dForCity = p.__canon_dpto_for_city ?? ((cCanon === 'bogota' || cCanon === 'bogota d c' || cCanon === 'bogota dc') ? 'bogota dc' : dCanon);
    const key = (nivel === 'departamento') ? dCanon : (cCanon ? `${cCanon}__${dForCity}` : '');
    const v = valores?.get(key) || 0;
    const title = (nivel === 'departamento') ? dDisp : `${cDisp} (${dDisp})`;
    hoverTip.setLatLng(e.latlng).setContent(`${title}<br><strong>$${Math.round(v).toLocaleString()}</strong>`);
    if (!hoverTip._map) hoverTip.addTo(mapa);
  });
  layer.on("mouseout", () => { if (hoverTip && hoverTip._map) mapa.removeLayer(hoverTip); });
  layer.on("click", () => { try { mapa.fitBounds(layer.getBounds().pad(0.25)); } catch {} });
}

function buildBaseLayersOnce() {
  if (layerDeptos || layerCiudades) return;
  if (!geoDeptos || !geoCiudades) return; // asegura cargarGeoJSON primero

  const common = {
    renderer: canvasRenderer,
    smoothFactor: 1.35,           // simplifica dibujo
    updateWhenZooming: false,     // redibuja al final
    updateWhenIdle: true,
    interactive: true,
    bubblingMouseEvents: false,
    style: () => ({               // estilo neutro inicial
      className: "poly-glow",
      fillColor: "#0b1020",
      weight: 0.8,
      opacity: 1,
      color: "#0f172a",
      fillOpacity: 0.85
    })
  };

  // Construye por chunks para no bloquear
  layerDeptos = L.geoJSON([], common); layerDeptos._nivel = 'departamento';
  layerCiudades = L.geoJSON([], common); layerCiudades._nivel = 'ciudad';

  // carga geometrías
  addGeoJSONChunked(geoDeptos, {}, null, (g) => { layerDeptos.addData(geoDeptos); });
  addGeoJSONChunked(geoCiudades, {}, null, (g) => { layerCiudades.addData(geoCiudades); });

  // inicia mostrando departamentos
  layerDeptos.addTo(mapa);
  layerPoligonos = layerDeptos;
}



function nombreDeptoFromFeature(f) {
  const p = f?.properties || {};
  if (DETECTED_DEPT_PROP && p[DETECTED_DEPT_PROP] != null && p[DETECTED_DEPT_PROP] !== '') {
    return String(p[DETECTED_DEPT_PROP]);
  }
  return pick(p, ["shapeName","NAME_1","NOMBRE_DPT","NOMBRE_DEP","DEPARTAMEN","DPTO_CNMBR","departamento","DEPARTAMENTO","dpto","dpt","name"]) || "";
}
function nombreCiudadFromFeature(f) {
  const p = f?.properties || {};
  if (DETECTED_CITY_PROP && p[DETECTED_CITY_PROP] != null && p[DETECTED_CITY_PROP] !== '') {
    return String(p[DETECTED_CITY_PROP]);
  }
  return pick(p, ["shapeName","NAME_2","NOMBRE_MPIO","MPIO_CNMBR","municipio","MUNICIPIO","ciudad","CIUDAD","NOMBRE_CIU","name"]) || "";
}

function ensureSmoothCSS() {
  if (document.getElementById('leaflet-smooth-style')) return;
  const style = document.createElement('style');
  style.id = 'leaflet-smooth-style';
  style.textContent = `
    .leaflet-interactive {
      transition: fill 180ms ease, stroke 180ms ease, fill-opacity 180ms ease, stroke-width 120ms ease;
    }
  `;
  document.head.appendChild(style);
}


function detectPropNames(geo, level) {
  const feats = geo?.features || [];
  if (!feats.length) return;

  const total = feats.length;
  const MAX_SAMPLE = Math.min(total, 1000);

  // Prioridades conocidas
  const PRIOR_DEPT = ["NAME_1","name_1","NOMBRE_DPT","NOMBRE_DEP","DEPARTAMEN","DPTO_CNMBR","departamento","DEPARTAMENTO","dpto","dpt","shapeName","NAME","name"];
  const PRIOR_CITY = ["NAME_2","name_2","NOMBRE_MPIO","MPIO_CNMBR","municipio","MUNICIPIO","ciudad","CIUDAD","NOMBRE_CIU","shapeName","NAME","name"];

  const disallowRe = /(objectid|shapeid|^id$|_id$|^gid$|code|cod|c_digo)/i;
  const nameHintRe = (level === 'departamento')
    ? /(depart|dpto|name_1|adm1|prov|estado|shape|name)/i
    : /(ciud|mpio|municip|name_2|adm2|local|town|city|shape|name)/i;

  const stats = new Map(); // key -> {present, uniq:Set, alpha}
  const alphaRatio = (s) => {
    const t = String(s||'');
    const alpha = (t.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g)||[]).length;
    return alpha / Math.max(1, t.length);
  };

  // sampleo
  for (let i = 0; i < MAX_SAMPLE; i++) {
    const p = feats[i]?.properties || {};
    for (const [k, v] of Object.entries(p)) {
      if (v == null) continue;
      const s = String(v).trim();
      if (!s) continue;
      let st = stats.get(k);
      if (!st) st = { present: 0, uniq: new Set(), alpha: 0 };
      st.present++;
      st.uniq.add(canonBase(s));
      st.alpha += alphaRatio(s);
      stats.set(k, st);
    }
  }

  const scoreKey = (k) => {
    const st = stats.get(k); if (!st) return -1;
    const presentRatio = st.present / MAX_SAMPLE;
    const uniqRatio = Math.min(1, st.uniq.size / MAX_SAMPLE);
    const avgAlpha = st.alpha / Math.max(1, st.present);

    // filtros básicos
    if (presentRatio < 0.5) return -1;       // muy ausente
    if (avgAlpha < 0.35) return -1;          // parece código numérico
    const disallow = disallowRe.test(k) ? 1 : 0;

    const isPriority = (level === 'departamento'
      ? PRIOR_DEPT.includes(k)
      : PRIOR_CITY.includes(k)) ? 1 : 0;

    const hint = nameHintRe.test(k) ? 1 : 0;

    // ponderación
    let score = 0;
    score += 2.5 * isPriority;
    score += 1.5 * hint;
    score += 2.0 * uniqRatio;
    score += 1.0 * presentRatio;
    score += 0.5 * avgAlpha;
    score -= 2.0 * disallow;

    return score;
  };

  let bestKey = null, bestScore = -1;
  for (const k of stats.keys()) {
    const sc = scoreKey(k);
    if (sc > bestScore) { bestScore = sc; bestKey = k; }
  }

  if (level === 'departamento') DETECTED_DEPT_PROP = bestKey;
  else DETECTED_CITY_PROP = bestKey;

  console.log(`[geo] clave detectada para ${level}:`, bestKey, 'score=', bestScore.toFixed(3));
}

function ensureBestCityPropForCoverage(geoCities, agregados) {
  try {
    const feats = geoCities?.features || [];
    if (!feats.length || !Array.isArray(agregados) || !agregados.length) return;

    // Set de claves backend (ciudad__depto)
    const backendKeys = new Set();
    for (const row of agregados) {
      const dCanon = canonDept(row.departamento || row.dpto || row.dep || "");
      const cCanon = canonCity(row.ciudad || row.municipio || row.mpio || "");
      const dForCity = (cCanon === 'bogota' || cCanon === 'bogota d c' || cCanon === 'bogota dc') ? 'bogota dc' : dCanon;
      if (cCanon) backendKeys.add(`${cCanon}__${dForCity}`);
    }
    if (backendKeys.size === 0) return;

    // Candidatos: todas las claves string-like presentes
    const sampleProps = Object.keys(feats[0]?.properties || {});
    const disallowRe = /(objectid|shapeid|^id$|_id$|^gid$|code|cod|c_digo)/i;
    const candidates = new Set([
      ...sampleProps,
      "NAME_2","name_2","NOMBRE_MPIO","MPIO_CNMBR","municipio","MUNICIPIO","ciudad","CIUDAD","NOMBRE_CIU","shapeName","NAME","name"
    ]);

    const scoreForProp = (prop) => {
      if (!prop || disallowRe.test(prop)) return -1;
      let present = 0, matches = 0, alphaSum = 0;
      const N = Math.min(feats.length, 3000);
      for (let i = 0; i < N; i++) {
        const p = feats[i]?.properties || {};
        const v = p[prop];
        if (v == null) continue;
        const s = String(v).trim();
        if (!s) continue;
        present++;
        const cCanon = canonCity(s);
        const dCanon = p.__canon_dpto ?? canonDept(nombreDeptoFromFeature(feats[i]));
        const dForCity = (cCanon === 'bogota' || cCanon === 'bogota d c' || cCanon === 'bogota dc') ? 'bogota dc' : dCanon;
        const key = cCanon ? `${cCanon}__${dForCity}` : '';
        if (key && backendKeys.has(key)) matches++;
        // Heurística: más letras mejor
        const alpha = (s.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g)||[]).length;
        alphaSum += alpha / Math.max(1, s.length);
      }
      if (present === 0) return -1;
      const presentRatio = present / Math.min(N, feats.length);
      const avgAlpha = alphaSum / present;
      if (presentRatio < 0.5 || avgAlpha < 0.35) return -1;
      // score = cobertura primaria + señales suaves
      return matches + 0.3 * presentRatio + 0.2 * avgAlpha;
    };

    let best = DETECTED_CITY_PROP || null;
    let bestScore = best ? scoreForProp(best) : -1;

    for (const prop of candidates) {
      const sc = scoreForProp(prop);
      if (sc > bestScore) { bestScore = sc; best = prop; }
    }

    if (best && best !== DETECTED_CITY_PROP) {
      console.log(`[geo] city prop mejor por cobertura: ${DETECTED_CITY_PROP} -> ${best} (score=${bestScore.toFixed(2)})`);
      DETECTED_CITY_PROP = best;
    }
  } catch (e) {
    console.warn('ensureBestCityPropForCoverage error:', e);
  }
}


// 3) Augment: escribe claves canónicas en cada feature para que el estilo siempre coincida
function augmentGeo(geo, level) {
  try {
    const feats = geo?.features || [];
    for (const f of feats) {
      const p = f.properties || (f.properties = {});
      const dRaw = nombreDeptoFromFeature(f);
      const cRaw = nombreCiudadFromFeature(f);
      const dCanon = canonDept(dRaw);
      const cCanon = canonCity(cRaw);
      p.__canon_dpto = dCanon;
      p.__canon_city = cCanon;
      p.__canon_dpto_for_city = isBogotaCityCanon(cCanon) ? 'bogota dc' : dCanon;
    }
  } catch (e) {
    console.warn('augmentGeo error:', e);
  }
}



async function fetchAggregadosPorNivel(nivel, signal) {
  const extra = { group_by: nivel }; // "departamento" | "ciudad"
  const query = getQueryFromFiltros(extra);
  const url = `${api}/ventas/mapa?${query}`;
  const res = await cachedFetch(url, { signal }, 30*1000);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

/* Degradé azul → morado. Cero en gris */
function colorScale(value, max) {
  if (!value || value <= 0) return "#9ca3af"; // gray-400
  const n = Math.max(1, Number(max) || 1);
  const r = Math.max(0, Math.min(1, value / n));
  if (r <= 0.15) return "#1e3a8a";
  if (r <= 0.35) return "#3b82f6";
  if (r <= 0.55) return "#6366f1";
  if (r <= 0.75) return "#8b5cf6";
  if (r <= 0.9)  return "#a855f7";
  return "#c084fc";
}

function limpiarCapaPoligonos() {
  if (layerPoligonos) { mapa.removeLayer(layerPoligonos); layerPoligonos = null; }
  const custom = document.querySelector('#map .map-legend');
  if (custom && custom.parentNode) custom.parentNode.removeChild(custom);
}

/* Leyenda */
function crearLeyenda(max, titulo = "Ventas") {
  if (mapa && mapa._legendControl) {
    try { mapa.removeControl(mapa._legendControl); } catch {}
    mapa._legendControl = null;
  }
  const stops = [0.0, 0.15, 0.35, 0.55, 0.75, 0.9, 1.0];

  const legend = L.control({ position: "bottomright" });
  legend.onAdd = function () {
    const div = L.DomUtil.create("div", "info legend");
    Object.assign(div.style, {
      background: "rgba(17, 24, 39, 0.88)",
      color: "#fff",
      padding: "10px 12px",
      borderRadius: "12px",
      fontSize: "12px",
      lineHeight: "1.25",
      boxShadow: "0 8px 24px rgba(0,0,0,.35)",
      zIndex: 10000
    });
    div.innerHTML = `<strong>${titulo}</strong><br/>`;
    for (let i = 0; i < stops.length - 1; i++) {
      const from = stops[i], to = stops[i + 1];
      const c = colorScale(to * max, max);
      div.innerHTML +=
        `<i style="background:${c};width:12px;height:12px;display:inline-block;margin-right:6px;border-radius:3px;box-shadow:0 0 10px ${c}55;"></i>` +
        `${Math.round(from*100)}%${to < 1 ? '&ndash;' + Math.round(to*100) + '%' : '+'}<br>`;
    }
    return div;
  };
  legend.addTo(mapa);
  mapa._legendControl = legend;
}

function wireEventos() {
  const btnKPIs  = document.getElementById("btnKPIs");
  const btnSerie = document.getElementById("btnSerie");
  const btnMapa  = document.getElementById("btnMapa");

  if (btnKPIs)  btnKPIs.addEventListener("click", cargarKPIs);
  if (btnSerie) btnSerie.addEventListener("click", cargarGrafico);
  if (btnMapa)  btnMapa.addEventListener("click", async () => {
    await cargarKPIs(); await renderCoropletas(); await cargarGrafico();
  });

  // Botones de nivel
  const btnDepto = document.getElementById("nivel-departamento");
  const btnCiudad = document.getElementById("nivel-ciudad");
  if (btnDepto) btnDepto.addEventListener("click", async () => {
    window.nivelMapa = "departamento";
    await renderCoropletas();
  });
  if (btnCiudad) btnCiudad.addEventListener("click", async () => {
    window.nivelMapa = "ciudad";
    await renderCoropletas();
  });

  // Filtros → cascada + refrescos
  const onFilterChange = debounce(async () => {
    if (_filtersUpdating) return;
    await syncCascadingFilters();
    await cargarKPIs();
    await renderCoropletas();
    await cargarGrafico();
  }, 200);

  filtrosKeys.forEach((key) => {
    const el = document.getElementById(key);
    if (el) el.addEventListener("change", onFilterChange);
  });
}


/* Render por chunks para fluidez (sin jank) */
function addGeoJSONChunked(base, options, onProgress, done) {
  const feats = (base && base.features) ? base.features : [];
  if (!feats.length) { if (typeof done === 'function') done(null); return; }

  // Capa única (Canvas) y añadir en lotes
  const layer = L.geoJSON([], options).addTo(mapa);

  let i = 0;
  const sliceSize   = 120; // ↑ lotes más grandes para acelerar
  const frameBudget = 12;  // ms por frame (~60fps)

  const hasRIC = typeof window.requestIdleCallback === 'function';
  const rICSupportsOptions = (() => {
    if (!hasRIC) return false;
    try {
      const id = window.requestIdleCallback(function(){}, { timeout: 0 });
      if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(id);
      return true;
    } catch (_) { return false; }
  })();

  const schedule = (cb) => {
    if (hasRIC) return rICSupportsOptions ? window.requestIdleCallback(cb, { timeout: 60 })
                                          : window.requestIdleCallback(cb);
    if (typeof window.requestAnimationFrame === 'function') return window.requestAnimationFrame(cb);
    return setTimeout(cb, 0);
  };

  function run(deadline) {
    const now = (typeof performance !== 'undefined' && performance.now) ? () => performance.now() : () => Date.now();
    const start = now();

    while (
      i < feats.length &&
      (
        (deadline && typeof deadline.timeRemaining === 'function' && deadline.timeRemaining() > 8) ||
        (!deadline && (now() - start) < frameBudget)
      )
    ) {
      const end = Math.min(i + sliceSize, feats.length);
      layer.addData({ type: "FeatureCollection", features: feats.slice(i, end) });
      i = end;
      if (typeof onProgress === 'function') onProgress(i / feats.length);
    }

    if (i < feats.length) {
      schedule(run);
    } else {
      if (typeof done === 'function') done(layer);
    }
  }

  schedule(run);
}

function repaintExistingLayer(layer, styleFn) {
  if (!layer || typeof layer.eachLayer !== 'function') return false;

  let painted = 0;
  try {
    layer.eachLayer((child) => {
      if (child && typeof child.setStyle === 'function') {
        const f  = child.feature || {};
        const st = styleFn(f) || {};
        child.setStyle(st);
        painted++;
      }
    });
  } catch (e) {
    console.warn('repaintExistingLayer falló, redibujando:', e);
    return false;
  }
  return painted > 0;
}




/* ====== Filtros en cascada (frontend) ====== */
let _filtersUpdating = false;

async function syncCascadingFilters() {
  try {
    _filtersUpdating = true;

    // bloquea mientras carga
    filtrosKeys.forEach((k) => {
      const el = document.getElementById(k);
      if (el) { el.disabled = true; el.title = "Actualizando…"; }
    });

    const query = getQueryFromFiltros();
    const res = await cachedFetch(`${api}/filtros?${query}`, {}, 10 * 60 * 1000);
    const data = await res.json();

    // repobla cada select con lo permitido por el backend
    filtrosKeys.forEach((k) => {
      const el = document.getElementById(k);
      if (!el) return;
      populateSelect(el, data[k] || [], el.value);
      el.title = "";
    });
  } catch (e) {
    console.error("Error sincronizando filtros:", e);
  } finally {
    _filtersUpdating = false;
    filtrosKeys.forEach((k) => {
      const el = document.getElementById(k);
      if (el) el.disabled = false;
    });
  }
}

/* =================== Mapa: render =================== */
async function renderCoropletas() {
  initMapaSiNecesario();

  // aborta render anterior si existía
  if (aborts.mapa) aborts.mapa.abort();
  aborts.mapa = new AbortController();
  const { signal } = aborts.mapa;

  try {
    loaders.mapa.setText("Cargando geografía…");

    // Nivel: respeta toggle; si no hay, deduce por ciudad seleccionada
    const filtros = getFiltros();
    const nivel = window.nivelMapa || (filtros.ciudad ? "ciudad" : "departamento");

    // Asegura geografía cargada (y autodetección de props ya ejecuta en cargarGeoJSON)
    await cargarGeoJSON(nivel);
    const base = (nivel === "departamento") ? geoDeptos : geoCiudades;
    if (!base || !Array.isArray(base.features) || base.features.length === 0) {
      throw new Error("GeoJSON no cargado o vacío");
    }
    if (signal.aborted) return;

    // Pide agregados al backend (con retries dentro de cachedFetch)
    let agregados = [];
    try {
      agregados = await fetchAggregadosPorNivel(nivel, signal);
    } catch (e) {
      if (signal.aborted) return;
      console.warn("No se pudieron cargar agregados del backend:", e);
      agregados = [];
    }
    if (signal.aborted) return;
    loaders.mapa.setText("Calculando ventas…");

    // Normaliza y acumula valores
    const valores = new Map();
    let maxVal = 0;

    for (const row of agregados) {
      const dCanon = canonDept(row.departamento || row.dpto || row.dep || "");
      const cCanon = canonCity(row.ciudad || row.municipio || row.mpio || "");

      const key = (nivel === "departamento")
        ? dCanon
        : (cCanon ? `${cCanon}__${(isBogotaCityCanon(cCanon) ? 'bogota dc' : dCanon)}` : "");

      if (!key) continue;

      const total = Number(row.total ?? row.valor ?? row.ventas ?? 0) || 0;
      const acc = (valores.get(key) || 0) + total;
      valores.set(key, acc);
      if (acc > maxVal) maxVal = acc;
    }

    // Estilo por feature (usa claves canónicas + caso especial Bogotá)
    const styleFn = (feature) => {
      const dRaw   = nombreDeptoFromFeature(feature);
      const cRaw   = nombreCiudadFromFeature(feature);
      const dCanon = canonDept(dRaw);
      const cCanon = canonCity(cRaw);

      const mapKey = (nivel === "departamento")
        ? dCanon
        : (cCanon ? `${cCanon}__${(isBogotaCityCanon(cCanon) ? 'bogota dc' : dCanon)}` : "");

      const v = valores.get(mapKey) || 0;
      return {
        className: "poly-glow",
        fillColor: colorScale(v, maxVal || 1),
        weight: 0.9,
        opacity: 1,
        color: "#0f172a",
        fillOpacity: 0.92
      };
    };

    const onEachFeature = (feature, layer) => {
      const dDisp  = nombreDeptoFromFeature(feature) || "—";
      const cDisp  = nombreCiudadFromFeature(feature) || "—";
      const dCanon = canonDept(dDisp);
      const cCanon = canonCity(cDisp);

      const mapKey = (nivel === "departamento")
        ? dCanon
        : (cCanon ? `${cCanon}__${(isBogotaCityCanon(cCanon) ? 'bogota dc' : dCanon)}` : "");

      const v = valores.get(mapKey) || 0;
      const title = (nivel === "departamento") ? dDisp : `${cDisp} (${dDisp})`;

      layer.bindTooltip(`${title}<br><strong>$${Math.round(v).toLocaleString()}</strong>`, { sticky: true });
      layer.on("click", () => { try { mapa.fitBounds(layer.getBounds().pad(0.25)); } catch {} });
      layer.on("mouseover", function () { this.setStyle({ weight: 1.6, color: "#ffffff", fillOpacity: 0.96 }); });
      layer.on("mouseout",  function () { this.setStyle({ weight: 0.9, color: "#0f172a", fillOpacity: 0.92 }); });
    };

    // Si ya hay capa del mismo nivel, intenta SOLO repintar (mucho más fluido)
    if (
      layerPoligonos &&
      layerPoligonos._nivel === nivel &&
      typeof layerPoligonos.eachLayer === "function"
    ) {
      const ok = repaintExistingLayer(layerPoligonos, styleFn);
      crearLeyenda(maxVal || 1, nivel === 'departamento' ? 'Ventas por departamento' : 'Ventas por ciudad');

      if (ok) {
        if (signal.aborted) return;
        try {
          const b = layerPoligonos.getBounds?.();
          if (b) mapa.fitBounds(b.pad(0.1), { animate: true });
        } catch {}
        return;
      }
      // si no se pudo repintar, seguimos a redibujar desde cero (fallback)
    }

    if (signal.aborted) return;

    // Cambió el nivel o no existía la capa: redibuja geometrías en chunks
    limpiarCapaPoligonos();
    loaders.mapa.setText("Dibujando mapa… 0%");

    await new Promise((resolve) => {
      addGeoJSONChunked(
        base,
        { style: styleFn, onEachFeature },
        (p) => loaders.mapa.setProgress(p),
        (layer) => {
          if (signal.aborted) { try { mapa.removeLayer(layer); } catch {} ; return resolve(); }
          layerPoligonos = layer;
          layerPoligonos._nivel = nivel; // guarda nivel actual
          resolve();
        }
      );
    });

    if (signal.aborted) return;

    // Ajusta vista y leyenda
    try {
      const bounds = layerPoligonos.getBounds?.();
      if (bounds) {
        mapa.fitBounds(bounds.pad(0.1), { animate: true });
        mapa.setZoom(mapa.getZoom() + 1, { animate: false }); // un nivel más cercano
      }
    } catch {}
    crearLeyenda(maxVal || 1, nivel === 'departamento' ? 'Ventas por departamento' : 'Ventas por ciudad');

  } catch (e) {
    if (e.name !== "AbortError") console.error("Mapa error:", e);
  } finally {
    loaders.mapa.hide();
    aborts.mapa = null;
  }
}




/* =================== Export CSV =================== */
async function exportarCSV() {
  const filtros = getFiltros();
  const res = await fetch(`${api}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(filtros),
  });
  const blob = await res.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "ventas_export.csv";
  a.click();
  window.URL.revokeObjectURL(url);
}

/* =================== Eventos UI =================== */
function initMapaSiNecesario() {
  if (mapa) return;
  const mapDiv = document.getElementById("map");
  if (!mapDiv) return;

  // Fondo negro, SIN tiles
  mapDiv.style.background = "#000";
  mapa = L.map("map", {
    minZoom: 4,
    zoom: 5,
    center: [4.6, -74.1],
    zoomControl: true,
    preferCanvas: true
  });

  // transición suave al recolorear
  (function injectOnce(){
    if (document.getElementById("leaflet-style-smooth")) return;
    const s = document.createElement("style");
    s.id = "leaflet-style-smooth";
    s.textContent = `
      .leaflet-container .poly-glow {
        transition: fill 180ms ease, fill-opacity 180ms ease, stroke 120ms ease;
      }
    `;
    document.head.appendChild(s);
  })();

  if (!loaders.mapa) loaders.mapa = makeOverlayWithProgress(mapDiv, { dark: true });
  loaders.mapa.show("Cargando mapa…");
}


/* =================== Bootstrap =================== */
async function cargarTodo() {
  await syncCascadingFilters(); // filtros en cascada desde el backend
  await cargarKPIs();
  await renderCoropletas();
  await cargarGrafico();
  wireEventos();
}

window.addEventListener("load", cargarTodo);
