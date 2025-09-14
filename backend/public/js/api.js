// backend/public/js/api.js
import { api, cachedFetch } from "./utils.js";

/* ===================== Helpers de filtros ===================== */
// Campos numéricos que queremos enviar como número (si vienen)
const NUMERIC_KEYS = ["inv_meta", "inv_google"];

// Normaliza números tipo "1.234,56" o "1,234.56" -> 1234.56
function toNumberLoose(x) {
  const s = String(x ?? "").replace(/[^\d.,-]/g, "").trim();
  if (!s) return "";
  if (s.includes(",") && s.includes(".")) return String(parseFloat(s.replace(/,/g, "")));
  if (s.includes(",") && !s.includes(".")) return String(parseFloat(s.replace(/\./g, "").replace(",", ".")));
  const n = parseFloat(s);
  return Number.isFinite(n) ? String(n) : "";
}

/**
 * Construye la query string desde el objeto de filtros:
 * - omite claves con '', null o undefined
 * - preserva "0" (cero) como valor válido
 * - normaliza numéricos para inv_meta / inv_google
 */
export function getQueryFromFiltros(filtros = {}) {
  const params = new URLSearchParams();

  Object.entries(filtros || {}).forEach(([k, v]) => {
    // omitimos null/undefined
    if (v === null || v === undefined) return;

    // Normaliza strings
    let val = typeof v === "string" ? v.trim() : v;

    // omite vacío "" pero conserva "0"
    if (val === "") return;

    // Normaliza numéricos definidos
    if (NUMERIC_KEYS.includes(k)) {
      val = toNumberLoose(val);
      if (val === "") return; // si quedó inválido, no lo enviamos
    }

    params.set(k, String(val));
  });

  return params.toString();
}

/** ===================== Endpoints ===================== */

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
  // En export mandamos JSON; normalizamos numéricos también
  const payload = { ...filtrosActuales };
  NUMERIC_KEYS.forEach((k) => {
    if (payload[k] !== undefined && payload[k] !== null && payload[k] !== "") {
      const n = toNumberLoose(payload[k]);
      if (n !== "") payload[k] = Number(n);
      else delete payload[k];
    }
  });

  const res = await fetch(`${api}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} al exportar CSV`);
  return res.blob();
}
