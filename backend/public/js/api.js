// backend/public/js/api.js
import { api, cachedFetch } from "./utils.js";

export function getQueryFromFiltros(filtros = {}) {
  const params = new URLSearchParams(filtros);
  return params.toString();
}

/** Filtros en cascada */
export async function fetchFiltros(filtrosActuales = {}, signal) {
  const query = getQueryFromFiltros(filtrosActuales);
  const res = await cachedFetch(`${api}/filtros?${query}`, { signal }, 10 * 60 * 1000);
  return res.json();
}

/** KPIs */
export async function fetchKPIs(filtrosActuales = {}, signal) {
  const query = getQueryFromFiltros(filtrosActuales);
  const res = await cachedFetch(`${api}/kpis?${query}`, { signal }, 30 * 1000);
  return res.json();
}

/** Serie temporal (chart) */
export async function fetchSeries(filtrosActuales = {}, signal) {
  const query = getQueryFromFiltros(filtrosActuales);
  const res = await cachedFetch(`${api}/ventas/series?${query}`, { signal }, 30 * 1000);
  return res.json();
}

/** Agregados para mapa */
export async function fetchMapaAggregates(nivel, filtrosActuales = {}, signal) {
  const extra = { ...filtrosActuales, group_by: nivel };
  const query = getQueryFromFiltros(extra);
  const res = await cachedFetch(`${api}/ventas/mapa?${query}`, { signal }, 30 * 1000);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

/** Export CSV */
export async function exportCSV(filtrosActuales = {}, signal) {
  const res = await fetch(`${api}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(filtrosActuales),
    signal
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} al exportar CSV`);
  return res.blob();
}

