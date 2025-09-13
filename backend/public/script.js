// public/script.js
const api = window.location.origin;

/* =================== Estado global =================== */
let mapa, chart;
let layerPoligonos = null;
let geoDeptos = null;   // GeoJSON ADM1 (departamentos)
let geoCiudades = null; // GeoJSON ADM2 (municipios/ciudades)
let nivelMapa = 'departamento'; // controlado desde index.html

/* Loaders / Abort por sección */
const aborts  = { kpis: null, series: null, mapa: null };
const loaders = { kpis: null, series: null, mapa: null };

/* Cache simple con TTL */
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
  for (let i = 0; i < 3; i++) {
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
      lastErr = e;
      if (i < 2) await sleep(300 * (i + 1)); // backoff: 300ms, 600ms
    }
  }
  throw lastErr;
}


/* =================== Rutas locales GeoJSON =================== */
const URL_DEPTOS   = `${api}/geo/departamentos.geojson`;
const URL_CIUDADES = `${api}/geo/ciudades.geojson`;

/* =================== Helpers base =================== */
const filtrosKeys = ["departamento", "ciudad", "macrocategoria", "categoria", "subcategoria", "marca"];

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

/* =================== GeoJSON local (cacheado) =================== */
async function cargarGeoJSON() {
  try {
    if (!geoDeptos) {
      const resD = await cachedFetch(URL_DEPTOS, {}, 24*60*60*1000);
      if (!resD.ok) throw new Error(`No se pudo cargar ${URL_DEPTOS}`);
      geoDeptos = await resD.json();
    }
    if (!geoCiudades) {
      const resC = await cachedFetch(URL_CIUDADES, {}, 24*60*60*1000);
      if (!resC.ok) throw new Error(`No se pudo cargar ${URL_CIUDADES}`);
      geoCiudades = await resC.json();
    }
  } catch (e) {
    console.error("Error cargando GeoJSON locales:", e);
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
    if (chart) chart.destroy();
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
  } catch (e) {
    if (e.name !== "AbortError") console.error("Serie error:", e);
  } finally {
    loaders.series.hide();
    aborts.series = null;
  }
}

/* =================== Mapa (coropletas) =================== */
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

  // loader visible desde el inicio
  if (!loaders.mapa) loaders.mapa = makeOverlayWithProgress(mapDiv, { dark: true });
  loaders.mapa.show("Cargando mapa…");
}

function nombreDeptoFromFeature(f) {
  const p = f?.properties || {};
  return pick(p, ["shapeName", "NAME_1", "NOMBRE_DPT", "NOMBRE_DEP", "DEPARTAMEN", "DPTO_CNMBR", "departamento", "DEPARTAMENTO", "dpto", "dpt", "name"]) || "";
}
function nombreCiudadFromFeature(f) {
  const p = f?.properties || {};
  return pick(p, ["shapeName", "NAME_2", "NOMBRE_MPIO", "MPIO_CNMBR", "municipio", "MUNICIPIO", "ciudad", "CIUDAD", "NOMBRE_CIU", "name"]) || "";
}

async function fetchAggregadosPorNivel(nivel, signal) {
  const extra = { group_by: nivel }; // "departamento" | "ciudad"
  const query = getQueryFromFiltros(extra);
  const url = `${api}/ventas/mapa?${query}`;
  const res = await cachedFetch(url, { signal }, 30*1000);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

/* Degradé azul → morado moderno */
function colorScale(value, max) {
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
  // eliminar cualquier leyenda previa (Leaflet control la maneja solo al recrear)
  const custom = document.querySelector('#map .map-legend'); // por si quedó una vieja custom
  if (custom && custom.parentNode) custom.parentNode.removeChild(custom);
}

/* ── LEYENDA (Leaflet control) ───────────────────────── */
function crearLeyenda(max, titulo = "Ventas") {
  // borrar control viejo si existe
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
  mapa._legendControl = legend; // guardar referencia para removerla luego
}

/* Render por chunks para fluidez */
function addGeoJSONChunked(base, options, onProgress, done) {
  const feats = (base && base.features) ? base.features : [];
  if (!feats.length) { done && done(null); return; }

  const group = L.featureGroup().addTo(mapa);
  let i = 0;
  const batch = 200;

  function step() {
    if (i >= feats.length) { done && done(group); return; }
    const end = Math.min(i + batch, feats.length);
    const slice = feats.slice(i, end);
    const fc = { type: "FeatureCollection", features: slice };
    L.geoJSON(fc, options).addTo(group);
    i = end;
    if (onProgress) onProgress(i / feats.length);
    (window.requestIdleCallback || window.requestAnimationFrame || setTimeout)(step, 0);
  }
  step();
}

async function renderCoropletas() {
  initMapaSiNecesario();
  if (aborts.mapa) aborts.mapa.abort();
  aborts.mapa = new AbortController();
  const signal = aborts.mapa.signal;

  try {
    loaders.mapa.setText("Cargando geografía…");

    // Nivel: usa el toggle si existe; si no, deduce por ciudad
    const filtros = getFiltros();
    const nivel = window.nivelMapa || (filtros.ciudad ? "ciudad" : "departamento");

    await cargarGeoJSON();
    const agregados = await fetchAggregadosPorNivel(nivel, signal);
    loaders.mapa.setText("Calculando ventas…");

    const valores = new Map();
    let maxVal = 0;
    for (const row of agregados) {
      const dpto = normalize(row.departamento || row.dpto || row.dep || "");
      const city = normalize(row.ciudad || row.municipio || row.mpio || "");
      const total = Number(row.total ?? row.valor ?? row.ventas ?? 0) || 0;

      let key;
      if (nivel === "departamento") key = dpto;
      else key = city && dpto ? `${city}__${dpto}` : city;

      if (!key) continue;
      const acc = (valores.get(key) || 0) + total;
      valores.set(key, acc);
      if (acc > maxVal) maxVal = acc;
    }

    limpiarCapaPoligonos();

    const base = (nivel === "departamento") ? geoDeptos : geoCiudades;
    const options = {
      style: (feature) => {
        const dptoName = normalize(nombreDeptoFromFeature(feature));
        const cityName = normalize(nombreCiudadFromFeature(feature));
        const key = (nivel === "departamento") ? dptoName : (cityName && dptoName ? `${cityName}__${dptoName}` : cityName);
        const v = valores.get(key) || 0;
        return {
          className: "poly-glow",
          fillColor: colorScale(v, maxVal || 1),
          weight: 0.9,
          opacity: 1,
          color: "#0f172a",
          fillOpacity: 0.92
        };
      },
      onEachFeature: (feature, layer) => {
        const dptoDisp = nombreDeptoFromFeature(feature) || "—";
        const cityDisp = nombreCiudadFromFeature(feature) || "—";
        const dptoKey  = normalize(dptoDisp);
        const cityKey  = normalize(cityDisp);
        const mapKey   = (nivel === "departamento") ? dptoKey : (cityKey && dptoKey ? `${cityKey}__${dptoKey}` : cityKey);
        const v = valores.get(mapKey) || 0;

        const title = (nivel === "departamento") ? dptoDisp : `${cityDisp} (${dptoDisp})`;
        layer.bindTooltip(`${title}<br><strong>$${Math.round(v).toLocaleString()}</strong>`, { sticky: true });

        layer.on("click", () => { try { mapa.fitBounds(layer.getBounds().pad(0.25)); } catch {} });
        layer.on("mouseover", function () { this.setStyle({ weight: 1.6, color: "#ffffff", fillOpacity: 0.96 }); });
        layer.on("mouseout",  function () { this.setStyle({ weight: 0.9, color: "#0f172a", fillOpacity: 0.92 }); });
      }
    };

    loaders.mapa.setText("Dibujando mapa… 0%");
    await new Promise((resolve) => {
      addGeoJSONChunked(base, options, (p) => loaders.mapa.setProgress(p), (group) => {
        layerPoligonos = group;
        resolve();
      });
    });

    try { mapa.fitBounds(layerPoligonos.getBounds().pad(0.1)); } catch {}
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
function wireEventos() {
  const btnKPIs  = document.getElementById("btnKPIs");
  const btnSerie = document.getElementById("btnSerie");
  const btnMapa  = document.getElementById("btnMapa");

  if (btnKPIs)  btnKPIs.addEventListener("click", cargarKPIs);
  if (btnSerie) btnSerie.addEventListener("click", cargarGrafico);
  if (btnMapa)  btnMapa.addEventListener("click", async () => {
    await cargarKPIs(); await renderCoropletas(); await cargarGrafico();
  });

  // Filtros refrescan todo
  filtrosKeys.forEach((key) => {
    const el = document.getElementById(key);
    if (el) {
      el.addEventListener("change", debounce(async () => {
        await cargarKPIs();
        await renderCoropletas();  // mapa primero
        await cargarGrafico();
      }, 200));
    }
  });

  // Refit mapa en resize
  window.addEventListener('resize', (()=>{ let t; return ()=>{ clearTimeout(t); t=setTimeout(()=>{ if (mapa && layerPoligonos) { try { mapa.invalidateSize(); mapa.fitBounds(layerPoligonos.getBounds().pad(0.1)); } catch {} } }, 120); }; })());
}

/* =================== Bootstrap =================== */
async function cargarTodo() {
  await cargarFiltros();
  await cargarKPIs();
  await renderCoropletas(); // Mapa primero (loader visible desde init)
  await cargarGrafico();    // Serie después
  wireEventos();
}

window.addEventListener("load", cargarTodo);
