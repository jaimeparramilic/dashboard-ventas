// backend/public/js/kpis.js
// Módulo KPIs — llama a GET /kpis con filtros + inversión en medios (inputs en MILLONES de COP)

const api = window.location.origin;

// ===== util =====
function toQuery(obj = {}) {
  const p = new URLSearchParams();
  Object.entries(obj).forEach(([k, v]) => {
    if (v !== undefined && v !== null && String(v) !== "") p.append(k, v);
  });
  return p.toString();
}
async function fetchWithRetry(url, opts = {}, retries = 2) {
  let err;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, opts);
      if (!res.ok) {
        const txt = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 160)}…`);
      }
      return res;
    } catch (e) {
      if (e?.name === "AbortError" || (opts?.signal && opts.signal.aborted)) throw e;
      err = e;
      if (i < retries) await new Promise(r => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw err;
}
function num(val) {
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

// === formato dinero en MILLONES de COP ===
function moneyM(n, { decimals = 1 } = {}) {
  const vM = (Number(n) || 0) / 1e6;
  const sign = vM < 0 ? "-" : "";
  const abs = Math.abs(vM);
  const hasDecimals = abs < 100 ? decimals : 0; // menos ruido en números grandes
  const s = abs.toLocaleString("es-CO", {
    minimumFractionDigits: 0,
    maximumFractionDigits: hasDecimals
  });
  return `${sign}$${s} M`;
}

// ===== loading spinner =====
export function setKPILoading(on = true) {
  const ids = ["kpi-ventas", "kpi-unidades", "kpi-ticket", "kpi-categorias"];
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (on) {
      el.dataset.prev = el.textContent || "";
      el.innerHTML = '<span class="spinner-border spinner-border-sm text-light"></span>';
    } else {
      if (el.dataset.prev !== undefined) delete el.dataset.prev;
    }
  });
}

// ===== estado abortable =====
let abortCtrl = null;

/**
 * Carga y pinta KPIs.
 * - getFiltros: fn que retorna { departamento, ciudad, macrocategoria, ... }
 * - Toma del DOM: inv_meta, inv_google (valores en MILLONES) → multiplica × 1e6 antes de enviar
 */
export async function cargarKPIs(getFiltros) {
  if (abortCtrl) abortCtrl.abort();
  abortCtrl = new AbortController();
  const { signal } = abortCtrl;

  try {
    setKPILoading(true);

    // 1) filtros “normales”
    const base = typeof getFiltros === "function" ? (getFiltros() || {}) : {};

    // 2) inversión desde inputs — EN MILLONES → convertir a unidades (×1e6)
    const invMetaVal   = document.getElementById("inv_meta")?.value ?? "";
    const invGoogleVal = document.getElementById("inv_google")?.value ?? "";

    const inv_meta_millones   = num(invMetaVal);
    const inv_google_millones = num(invGoogleVal);

    const inv_meta   = inv_meta_millones   * 1_000_000;
    const inv_google = inv_google_millones * 1_000_000;

    // 3) query final
    const filtros = { ...base, inv_meta, inv_google };
    const query = toQuery(filtros);
    const url = `${api}/kpis${query ? `?${query}` : ""}`;

    // 4) fetch
    const res = await fetchWithRetry(url, { signal }, 2);
    const data = await res.json();

    // 5) mapea campos devueltos por el back
    const totalVentas      = num(data.total_ventas ?? data.ventas);
    const unidadesVendidas = num(data.unidades_vendidas ?? data.unidades);
    const ticketPromedio   = num(data.ticket_promedio ?? data.ticket);
    const categoriasAct    = data.categorias_activas ?? data.categorias ?? "--";

    // 6) pinta (total y ticket en MILLONES)
    const elV = document.getElementById("kpi-ventas");
    const elU = document.getElementById("kpi-unidades");
    const elT = document.getElementById("kpi-ticket");
    const elC = document.getElementById("kpi-categorias");

    if (elV) elV.textContent = moneyM(totalVentas);
    if (elU) elU.textContent = unidadesVendidas.toLocaleString("es-CO");
    if (elT) elT.textContent = moneyM(ticketPromedio);
    if (elC) elC.textContent = String(categoriasAct);

  } catch (e) {
    if (e.name !== "AbortError") {
      console.error("[KPIs] error:", e);
      ["kpi-ventas","kpi-unidades","kpi-ticket","kpi-categorias"].forEach(id => {
        const el = document.getElementById(id); if (el) el.textContent = "--";
      });
    }
  } finally {
    setKPILoading(false);
    abortCtrl = null;
  }
}
