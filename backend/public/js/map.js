// backend/public/js/map.js
// --- imports (sin getFiltros; lo inyecta main.js) ---
import {
  cargarGeoJSON,
  geoDeptos,
  geoCiudades,
  DETECTED_CITY_PROP,
  ensureBestCityPropForCoverage,
  augmentGeo,
  nombreDeptoFromFeature,
  nombreCiudadFromFeature,
  canonBase, softClean, canonDept, canonCity, isBogotaCityCanon
} from './geo.js';

import { makeOverlayWithProgress, cachedFetch } from './utils.js';

// ====== Estado local del mapa ======
const api = window.location.origin;
let mapa, canvasRenderer, hoverTip;
let layerPoligonos = null;
const aborts  = { mapa: null };
const loaders = { mapa: null };

const DEBUG_GEO = false;

// ====== Helpers locales ======
function colorScale(value, max) {
  if (!value || value <= 0) return "#9ca3af";
  const n = Math.max(1, Number(max) || 1);
  const r = Math.max(0, Math.min(1, value / n));
  if (r <= 0.15) return "#1e3a8a";
  if (r <= 0.35) return "#3b82f6";
  if (r <= 0.55) return "#6366f1";
  if (r <= 0.75) return "#8b5cf6";
  if (r <= 0.9)  return "#a855f7";
  return "#c084fc";
}
// Mostrar COP en MILLONES
function formatMoneyM(n, { decimals = 1 } = {}) {
  const vM = (Number(n) || 0) / 1e6;
  const sign = vM < 0 ? "-" : "";
  const abs = Math.abs(vM);
  const hasDec = abs < 100 ? decimals : 0;
  const s = abs.toLocaleString("es-CO", { minimumFractionDigits: 0, maximumFractionDigits: hasDec });
  return `${sign}$${s} M`;
}
function crearLeyenda(max, titulo = "Ventas (M COP)") {
  if (mapa && mapa._legendControl) { try { mapa.removeControl(mapa._legendControl); } catch {} mapa._legendControl = null; }
  const stops = [0.0, 0.15, 0.35, 0.55, 0.75, 0.9, 1.0];
  const legend = L.control({ position: "bottomright" });
  legend.onAdd = function () {
    const div = L.DomUtil.create("div", "info legend");
    Object.assign(div.style, {
      background: "rgba(17, 24, 39, 0.88)",
      color: "#fff", padding: "10px 12px", borderRadius: "12px", fontSize: "12px", lineHeight: "1.25",
      boxShadow: "0 8px 24px rgba(0,0,0,.35)", zIndex: 10000
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
function limpiarCapaPoligonos() {
  if (layerPoligonos) { try { mapa.removeLayer(layerPoligonos); } catch {} ; layerPoligonos = null; }
  const custom = document.querySelector('#map .map-legend');
  if (custom && custom.parentNode) custom.parentNode.removeChild(custom);
}
function addGeoJSONChunked(base, options, onProgress, done) {
  const feats = (base && base.features) ? base.features : [];
  if (!feats.length) { if (typeof done === 'function') done(null); return; }

  const layer = L.geoJSON([], options).addTo(mapa);

  let i = 0;
  let sliceSize = 80;
  const MAX_MS_PER_RUN = 20;
  const MIN_SLICE = 20;
  const MAX_SLICE = 160;

  const hasRIC = typeof window.requestIdleCallback === 'function';
  const rICSupportsOptions = (() => {
    if (!hasRIC) return false;
    try {
      const id = window.requestIdleCallback(() => {}, { timeout: 0 });
      if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(id);
      return true;
    } catch (_) { return false; }
  })();

  const schedule = (cb) =>
    hasRIC ? (rICSupportsOptions ? window.requestIdleCallback(cb, { timeout: 40 }) : window.requestIdleCallback(cb))
           : (typeof window.requestAnimationFrame === 'function' ? window.requestAnimationFrame(cb) : setTimeout(cb, 0));

  function run(deadline) {
    const now = (typeof performance !== 'undefined' && performance.now) ? () => performance.now() : () => Date.now();
    const start = now();
    let softBudget = MAX_MS_PER_RUN;
    if (deadline && typeof deadline.timeRemaining === 'function') {
      const tr = deadline.timeRemaining();
      if (tr < 8 && sliceSize > MIN_SLICE) sliceSize = Math.max(MIN_SLICE, Math.floor(sliceSize * 0.75));
      softBudget = Math.min(MAX_MS_PER_RUN, Math.max(8, tr - 2));
    }
    while (i < feats.length) {
      const end = Math.min(i + sliceSize, feats.length);
      layer.addData({ type: "FeatureCollection", features: feats.slice(i, end) });
      i = end;
      if (typeof onProgress === 'function') onProgress(i / feats.length);
      const elapsed = now() - start;
      if (elapsed >= softBudget || elapsed >= MAX_MS_PER_RUN) break;
      if (elapsed < softBudget * 0.4 && sliceSize < MAX_SLICE) {
        sliceSize = Math.min(MAX_SLICE, Math.floor(sliceSize * 1.2));
      }
    }
    if (i < feats.length) schedule(run); else if (typeof done === 'function') done(layer);
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

// Forzar repintado del loader antes del trabajo pesado
function waitFrame(times = 1) {
  return new Promise((resolve) => {
    const step = () => (times-- > 0)
      ? requestAnimationFrame(step)
      : resolve();
    requestAnimationFrame(step);
  });
}

// ====== Export 1: init del mapa ======
export function initMapaSiNecesario() {
  if (mapa) return;

  const mapDiv = document.getElementById("map");
  if (!mapDiv) return;

  mapDiv.style.background = "#000";
  mapa = L.map("map", {
    minZoom: 4, zoom: 5, center: [4.6, -74.1],
    zoomControl: true, preferCanvas: true, zoomAnimation: false, fadeAnimation: false,
    inertia: true, wheelDebounceTime: 30, wheelPxPerZoomLevel: 120
  });

  canvasRenderer = L.canvas({ padding: 0.5 });

  if (!document.getElementById("leaflet-style-smooth")) {
    const s = document.createElement("style");
    s.id = "leaflet-style-smooth";
    s.textContent = `
      .leaflet-interactive, .poly-glow { transition: fill 160ms ease, fill-opacity 160ms ease, stroke 120ms ease, stroke-width 120ms ease; }
      .leaflet-tooltip.hover-tip {
        background: rgba(17,24,39,.92); color: #fff; border: 0; border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.35); padding: 6px 8px;
      }`;
    document.head.appendChild(s);
  }

  hoverTip = L.tooltip({ className: 'hover-tip', opacity: 0.95, sticky: true });
  if (!loaders.mapa) loaders.mapa = makeOverlayWithProgress(mapDiv, { dark: true });
  loaders.mapa.show("Cargando mapa…");
}

/** =================== Loader de transición de nivel =================== */
async function withMapaLoader(titulo, fn) {
  initMapaSiNecesario();
  try {
    if (!loaders.mapa) {
      const mapDiv = document.getElementById("map");
      loaders.mapa = makeOverlayWithProgress(mapDiv, { dark: true });
    }
    loaders.mapa.show(titulo);
    loaders.mapa.setProgress(0);

    // Fuerza que el overlay se pinte antes de seguir
    await waitFrame(2);

    const res = await fn((p, subt) => {
      if (typeof p === 'number') loaders.mapa.setProgress(Math.max(0, Math.min(1, p)));
      if (subt) loaders.mapa.setText(`${titulo}\n${subt}`);
    });
    return res;
  } finally {
    loaders.mapa.hide();
  }
}

/** Escala inversión (UI en millones → backend en unidades) */
function scaleInvMillions(filtros) {
  const f = { ...filtros };
  ["inv_meta", "inv_google"].forEach((k) => {
    const n = Number(f[k]);
    if (Number.isFinite(n)) f[k] = n * 1_000_000; // × 1e6
  });
  return f;
}

/**
 * Cambia el nivel del mapa con loader de transición.
 * - nuevoNivel: 'departamento' | 'ciudad'
 * - getFiltrosFn: función que devuelve el objeto de filtros actual
 */
export async function cambiarNivelConLoader(nuevoNivel, getFiltrosFn) {
  const titulo = nuevoNivel === 'ciudad' ? 'Cambiando a ciudades…' : 'Cambiando a departamentos…';
  return withMapaLoader(titulo, async (progress) => {
    // Paso 1: precargar GeoJSON del nuevo nivel
    progress?.(0.1, 'Precargando polígonos');
    await cargarGeoJSON(nuevoNivel);

    // Paso 2: recalcular augment según nivel
    if (nuevoNivel === 'ciudad') {
      progress?.(0.25, 'Ajustando columnas (ciudad)');
      ensureBestCityPropForCoverage(geoCiudades, []); // heurística sin agregados aún
      augmentGeo(geoCiudades, 'ciudad');
    } else {
      progress?.(0.25, 'Ajustando columnas (departamento)');
      augmentGeo(geoDeptos, 'departamento');
    }

    // Paso 3: dibujar coropletas
    progress?.(0.45, 'Calculando y pintando ventas');
    await renderCoropletas(getFiltrosFn, nuevoNivel, { noLoader: true });

    // Paso 4: pulido final UI
    progress?.(1.0, 'Listo');
  });
}

// ====== helper fetch agregados (usa la query actual) ======
async function fetchAggregadosPorNivel(nivel, filtros = {}, signal) {
  // ⬇️ IMPORTANTE: escalar inversión antes de llamar al backend del mapa
  const filtrosEscalados = scaleInvMillions(filtros);
  const params = new URLSearchParams({ ...filtrosEscalados, group_by: nivel });
  const res = await cachedFetch(`${api}/ventas/mapa?${params.toString()}`, { signal }, 30*1000);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// ====== alias para compatibilidad (algunos módulos llaman fetchMapaAggregates) ======
export async function fetchMapaAggregates(nivel, filtros, signal) {
  return fetchAggregadosPorNivel(nivel, filtros, signal);
}

// ====== Export 2: render principal ======
export async function renderCoropletas(getFiltrosFn, nivelPreferred, opts = {}) {
  const noLoader = !!opts.noLoader;
  initMapaSiNecesario();

  if (aborts.mapa) aborts.mapa.abort();
  aborts.mapa = new AbortController();
  const { signal } = aborts.mapa;

  try {
    // Loader según nivel (solo si no viene controlado externamente)
    const filtros = typeof getFiltrosFn === 'function' ? (getFiltrosFn() || {}) : {};
    const nivel = nivelPreferred || window.nivelMapa || (filtros.ciudad ? "ciudad" : "departamento");
    if (!noLoader) loaders.mapa.show(nivel === 'ciudad' ? "Cargando ciudades…" : "Cargando departamentos…");

    // Geo base
    await cargarGeoJSON(nivel);
    const baseFull = (nivel === "departamento") ? geoDeptos : geoCiudades;
    if (!baseFull || !Array.isArray(baseFull.features) || baseFull.features.length === 0) {
      throw new Error("GeoJSON no cargado o vacío");
    }
    if (nivel === "departamento") augmentGeo(geoDeptos, 'departamento');
    else {
      ensureBestCityPropForCoverage(geoCiudades, []); // se recalcula luego con agregados
      augmentGeo(geoCiudades, 'ciudad');
    }
    if (signal.aborted) return;

    // Agregados del backend
    let agregados = [];
    try {
      agregados = await fetchMapaAggregates(nivel, filtros, signal);
    } catch (e) {
      if (signal.aborted) return;
      if (DEBUG_GEO) console.warn("No se pudieron cargar agregados del backend:", e);
      agregados = [];
    }
    if (signal.aborted) return;

    // Ajuste de propiedad de ciudad por cobertura real
    if (nivel === 'ciudad') {
      if (!noLoader) loaders.mapa.setText("Optimizando columnas de ciudades…");
      const prevCityProp = DETECTED_CITY_PROP;
      ensureBestCityPropForCoverage(geoCiudades, agregados);
      if (DETECTED_CITY_PROP !== prevCityProp) {
        augmentGeo(geoCiudades, 'ciudad'); // recalcula __canon_city/__canon_dpto
      }
    }

    if (!noLoader) loaders.mapa.setText("Calculando ventas…");

    // ================== Acumulación de valores ==================
    const valores = new Map();              // depto o ciudad__depto (fallback)
    const valoresPorShapeID = new Map();    // preferido en nivel=ciudad si backend manda shapeID
    const valoresPorCityCanon = new Map();  // fallback por ciudad-sola si no hay depto
    let maxVal = 0;

    for (const row of agregados) {
      const total = Number(row.total ?? row.valor ?? row.ventas ?? 0) || 0;

      if (nivel === "ciudad" && row.shapeID) {
        const fid = String(row.shapeID);
        const acc = (valoresPorShapeID.get(fid) || 0) + total;
        valoresPorShapeID.set(fid, acc);
        if (acc > maxVal) maxVal = acc;
        continue;
      }

      const dCanon = canonDept(canonBase(row.departamento || row.dpto || row.dep || ""));
      if (nivel === "departamento") {
        const acc = (valores.get(dCanon) || 0) + total;
        valores.set(dCanon, acc);
        if (acc > maxVal) maxVal = acc;
      } else {
        // Fallbacks de ciudad
        const cCanon = canonCity(canonBase(row.ciudad || row.municipio || row.mpio || ""));
        if (!cCanon) continue;

        // 1) ciudad__depto (si el feature trae depto)
        const key = `${cCanon}__${(isBogotaCityCanon(cCanon) ? 'bogota dc' : dCanon)}`;
        const acc1 = (valores.get(key) || 0) + total;
        valores.set(key, acc1);
        if (acc1 > maxVal) maxVal = Math.max(maxVal, acc1);

        // 2) ciudad-sola (para features sin depto)
        const acc2 = (valoresPorCityCanon.get(cCanon) || 0) + total;
        valoresPorCityCanon.set(cCanon, acc2);
        if (acc2 > maxVal) maxVal = Math.max(maxVal, acc2);
      }
    }

    // ================== Diagnóstico de cobertura ==================
    (function coverageDiag(){
      try {
        const feats = baseFull?.features || [];
        let ok = 0, miss = [];

        if (nivel === 'ciudad' && valoresPorShapeID.size) {
          const fidSet = new Set(feats.map(f => String(f?.properties?.shapeID ?? f?.id ?? '')));
          for (const fid of valoresPorShapeID.keys()) {
            if (fidSet.has(String(fid))) ok++; else if (miss.length < 20) miss.push(fid);
          }
          if (DEBUG_GEO) console.log(`[map] nivel=${nivel} claves_backend=${valoresPorShapeID.size} | match_geo=${ok} | miss-ej:`, miss);
        } else if (nivel === 'ciudad' && valoresPorCityCanon.size) {
          const citySet = new Set(feats.map(f => canonCity(f?.properties?.__display_city || f?.properties?.shapeName || '')));
          for (const k of valoresPorCityCanon.keys()) {
            if (citySet.has(k)) ok++; else if (miss.length < 20) miss.push(k);
          }
          if (DEBUG_GEO) console.log(`[map] nivel=${nivel} claves_backend_cityOnly=${valoresPorCityCanon.size} | match_geo=${ok} | miss-ej:`, miss);
        } else {
          const featKeys = new Set();
          for (const f of feats) {
            const p = f.properties || {};
            const d = p.__canon_dpto;
            const c = p.__canon_city;
            const k = (nivel === 'departamento') ? d : (c ? `${c}__${(isBogotaCityCanon(c) ? 'bogota dc' : d)}` : '');
            if (k) featKeys.add(k);
          }
          for (const k of valores.keys()) {
            if (featKeys.has(k)) ok++; else if (miss.length < 20) miss.push(k);
          }
          if (DEBUG_GEO) console.log(`[map] nivel=${nivel} claves_backend=${valores.size} | match_geo=${ok} | miss-ej:`, miss);

          if (nivel === 'ciudad' && ok === 0 && DETECTED_CITY_PROP) {
            console.warn('[map] match_geo=0; re-augment forzado con', DETECTED_CITY_PROP);
            augmentGeo(geoCiudades, 'ciudad');
          }
        }
      } catch(e) { if (DEBUG_GEO) console.warn('coverageDiag', e); }
    })();

    // ================== Estilo por feature ==================
    const styleFn = (feature) => {
      const p = feature?.properties || {};
      const dCanon = p.__canon_dpto;
      const cCanon = p.__canon_city;

      let v = 0;
      if (nivel === "ciudad") {
        const fid = String(p.shapeID ?? p.__shapeID ?? p.id ?? '');
        if (fid && valoresPorShapeID.size) {
          v = valoresPorShapeID.get(fid) || 0;
        } else if (!dCanon && cCanon) {
          v = valoresPorCityCanon.get(cCanon) || 0;
        } else {
          const mapKey = (cCanon ? `${cCanon}__${(isBogotaCityCanon(cCanon) ? 'bogota dc' : dCanon)}` : "");
          v = valores.get(mapKey) || 0;
        }
      } else {
        v = valores.get(dCanon) || 0;
      }

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
      const p = feature?.properties || {};
      const dCanon = p.__canon_dpto;
      const cCanon = p.__canon_city;
      const dDisp  = nombreDeptoFromFeature(feature) || "—";
      const cDisp  = nombreCiudadFromFeature(feature) || "—";

      let v = 0;
      if (nivel === 'ciudad') {
        const fid = String(p.shapeID ?? p.__shapeID ?? p.id ?? '');
        if (fid && valoresPorShapeID.size) {
          v = valoresPorShapeID.get(fid) || 0;
        } else if (!dCanon && cCanon) {
          v = valoresPorCityCanon.get(cCanon) || 0;
        } else {
          const mapKey = (cCanon ? `${cCanon}__${(isBogotaCityCanon(cCanon) ? 'bogota dc' : dCanon)}` : "");
          v = valores.get(mapKey) || 0;
        }
      } else {
        v = valores.get(dCanon) || 0;
      }

      const title = (nivel === "departamento") ? dDisp : `${cDisp} (${dDisp})`;
      // Tooltip en MILLONES de COP
      layer.bindTooltip(`${title}<br><strong>${formatMoneyM(v)}</strong>`, { sticky: true });
      layer.on("click", () => { try { mapa.fitBounds(layer.getBounds().pad(0.25)); } catch {} });
      layer.on("mouseover", function () { this.setStyle({ weight: 1.6, color: "#ffffff", fillOpacity: 0.96 }); });
      layer.on("mouseout",  function () { this.setStyle({ weight: 0.9, color: "#0f172a", fillOpacity: 0.92 }); });
    };

    // ================== Reuso/redibujo ==================
    if (layerPoligonos && layerPoligonos._nivel === nivel && typeof layerPoligonos.eachLayer === "function") {
      const ok = repaintExistingLayer(layerPoligonos, styleFn);
      crearLeyenda(maxVal || 1, nivel === 'departamento' ? 'Ventas por departamento (M COP)' : 'Ventas por ciudad (M COP)');
      if (ok) {
        if (signal.aborted) return;
        try { const b = layerPoligonos.getBounds?.(); if (b) mapa.fitBounds(b.pad(0.1), { animate: true }); } catch {}
        return;
      }
    }

    limpiarCapaPoligonos();
    if (!noLoader) loaders.mapa.setText(nivel === 'ciudad' ? "Dibujando ciudades… 0%" : "Dibujando departamentos… 0%");

    await new Promise((resolve) => {
      addGeoJSONChunked(
        baseFull,
        { style: styleFn, onEachFeature },
        (p) => { if (!noLoader) loaders.mapa.setProgress(p); },
        (layer) => {
          if (signal.aborted) { try { mapa.removeLayer(layer); } catch {} ; return resolve(); }
          layerPoligonos = layer;
          layerPoligonos._nivel = nivel;
          resolve();
        }
      );
    });

    if (signal.aborted) return;

    try {
      const bounds = layerPoligonos.getBounds?.();
      if (bounds) {
        mapa.fitBounds(bounds.pad(0.1), { animate: true });
        if (nivel === 'ciudad') mapa.setZoom(Math.max(mapa.getZoom(), 8), { animate: false });
      }
    } catch {}
    crearLeyenda(maxVal || 1, nivel === 'departamento' ? 'Ventas por departamento (M COP)' : 'Ventas por ciudad (M COP)');

  } catch (e) {
    if (e.name !== "AbortError") console.error("Mapa error:", e);
  } finally {
    if (!opts.noLoader) loaders.mapa.hide();
    aborts.mapa = null;
  }
}
