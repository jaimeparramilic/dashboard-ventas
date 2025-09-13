// utils.js

export const api = window.location.origin;

/* =================== LocalStorage cache =================== */
export const GEO_VERSION = "v1";
const LSCACHE_DAYS = 30;
const LSCACHE_TTL = LSCACHE_DAYS * 24 * 60 * 60 * 1000;

export function lsGetJSON(key) {
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
export function lsSetJSON(key, data) {
  try { localStorage.setItem(key, JSON.stringify({ v: GEO_VERSION, t: Date.now(), data })); } catch {}
}

/* ============== In-mem cache with retries & TTL ============== */
const cache = new Map();
const cacheKey = (url, body) => (body ? `${url}|${JSON.stringify(body)}` : url);

export async function cachedFetch(url, opts = {}, ttlMs = 60_000) {
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
      if (e?.name === 'AbortError' || (opts?.signal && opts.signal.aborted)) throw e;
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

/* =================== Text/keys utils =================== */
export const filtrosKeys = ["departamento","ciudad","macrocategoria","categoria","subcategoria","segmento","marca"];

export const normalize = (str) => {
  if (str === null || str === undefined) return "";
  return String(str)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
};

export const debounce = (fn, wait = 300) => {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
};

export function pick(obj, keys) {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null && obj[k] !== "") return obj[k];
  }
  return undefined;
}

/* =================== Loader overlay =================== */
export function makeOverlayWithProgress(target, { dark = true } = {}) {
  const overlay = document.createElement("div");
  Object.assign(overlay.style, {
    position: "absolute", inset: "0", display: "flex",
    alignItems: "center", justifyContent: "center", flexDirection: "column", gap: "10px",
    background: dark ? "rgba(0,0,0,0.45)" : "transparent", zIndex: 999
  });
  const spinner = document.createElement("div");
  spinner.className = "spinner-border text-light"; spinner.setAttribute("role", "status");
  spinner.style.width = "2.25rem"; spinner.style.height = "2.25rem";
  const label = document.createElement("div");
  label.style.fontSize = "0.95rem"; label.style.opacity = "0.9"; label.textContent = "Cargando…";
  overlay.appendChild(spinner); overlay.appendChild(label);

  const parent = target; const prevPos = getComputedStyle(parent).position;
  if (prevPos === "static" || !prevPos) parent.style.position = "relative";

  return {
    show(text = "Cargando…") { label.textContent = text; if (!overlay.parentNode) parent.appendChild(overlay); },
    setText(text) { label.textContent = text; },
    setProgress(p) { label.textContent = `Dibujando mapa… ${Math.round(p*100)}%`; },
    hide() { try { parent.removeChild(overlay); } catch {} }
  };
}

export function setKPILoading(on = true) {
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
