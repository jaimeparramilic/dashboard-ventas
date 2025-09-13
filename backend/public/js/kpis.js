// backend/public/js/kpis.js
// Módulo KPIs — sin dependencias externas. Llama a GET /kpis con los filtros actuales.

// Config base
const api = window.location.origin;

// Estado para abortar cargas previas si el usuario cambia filtros rápido
let abortCtrl = null;

// Spinner simple en los 4 KPIs
export function setKPILoading(on = true) {
  const ids = ["kpi-ventas", "kpi-unidades", "kpi-ticket", "kpi-categorias"];
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (on) {
      el.dataset.prev = el.textContent || "";
      el.innerHTML = '<span class="spinner-border spinner-border-sm text-light"></span>';
    } else {
      if (el.dataset.prev !== undefined) {
        // si quieres restaurar lo previo, usa: el.textContent = el.dataset.prev;
        delete el.dataset.prev;
      }
    }
  });
}

// Helper: convierte {a:1,b:2} -> "a=1&b=2"
function toQuery(obj = {}) {
  const params = new URLSearchParams();
  Object.entries(obj).forEach(([k, v]) => {
    if (v !== undefined && v !== null && String(v) !== "") params.append(k, v);
  });
  return params.toString();
}

// fetch con reintentos livianos
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
      // si fue abortado, no reintentar
      if (e?.name === "AbortError" || (opts?.signal && opts.signal.aborted)) throw e;
      err = e;
      if (i < retries) await new Promise(r => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw err;
}

/**
 * Carga y pinta KPIs.
 * @param {Function} getFiltros Fn que retorna un objeto con filtros seleccionados (ej. {departamento, ciudad, ...})
 */
export async function cargarKPIs(getFiltros) {
  if (abortCtrl) abortCtrl.abort();
  abortCtrl = new AbortController();
  const { signal } = abortCtrl;

  try {
    setKPILoading(true);

    const filtros = typeof getFiltros === "function" ? (getFiltros() || {}) : {};
    const query = toQuery(filtros);
    const url = `${api}/kpis${query ? `?${query}` : ""}`;

    const res = await fetchWithRetry(url, { signal }, 2);
    const data = await res.json();

    const elV = document.getElementById("kpi-ventas");
    const elU = document.getElementById("kpi-unidades");
    const elT = document.getElementById("kpi-ticket");
    const elC = document.getElementById("kpi-categorias");

    const totalVentas     = Math.round(Number(data.total_ventas || data.ventas || 0));
    const unidadesVendidas= Math.round(Number(data.unidades_vendidas || data.unidades || 0));
    const ticketPromedio  = Math.round(Number(data.ticket_promedio || data.ticket || 0));
    const categoriasAct   = data.categorias_activas ?? data.categorias ?? "--";

    if (elV) elV.textContent = "$" + totalVentas.toLocaleString();
    if (elU) elU.textContent = unidadesVendidas.toLocaleString();
    if (elT) elT.textContent = "$" + ticketPromedio.toLocaleString();
    if (elC) elC.textContent = String(categoriasAct);
  } catch (e) {
    if (e.name !== "AbortError") {
      console.error("[KPIs] error:", e);
      // fallback visible simple
      const elV = document.getElementById("kpi-ventas");
      const elU = document.getElementById("kpi-unidades");
      const elT = document.getElementById("kpi-ticket");
      const elC = document.getElementById("kpi-categorias");
      if (elV) elV.textContent = "--";
      if (elU) elU.textContent = "--";
      if (elT) elT.textContent = "--";
      if (elC) elC.textContent = "--";
    }
  } finally {
    setKPILoading(false);
    abortCtrl = null;
  }
}
