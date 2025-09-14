// backend/public/js/filters.js
import { filtrosKeys, debounce } from "./utils.js";
import { fetchFiltros } from "./api.js";

let _filtersUpdating = false;

// Inputs numéricos agregados (no son <select>)
const EXTRA_INPUTS = ["inv_meta", "inv_google"];

/** Lee todos los filtros del DOM (incluye inversiones como número) */
export function getFiltros() {
  const filtros = {};

  // Lee los registrados en filtrosKeys (pueden ser <select> o <input>)
  filtrosKeys.forEach((key) => {
    const el = document.getElementById(key);
    if (!el) return;
    const val = el.value;
    if (val !== undefined && val !== null && String(val) !== "") {
      filtros[key] = val;
    }
  });

  // Asegura lectura de las inversiones aunque no estén en filtrosKeys
  EXTRA_INPUTS.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    const n = Number(el.value);
    filtros[id] = Number.isFinite(n) ? n : 0;
  });

  return filtros;
}

/** Pobla un <select> de forma segura (ignora inputs) */
export function populateSelect(select, values, previousValue) {
  // Solo opera con SELECT reales
  if (!select || String(select.tagName).toUpperCase() !== "SELECT") return;

  const prev = previousValue ?? select.value;

  // Limpia opciones
  while (select.firstChild) select.removeChild(select.firstChild);

  // Opción "Todas"
  const optAll = document.createElement("option");
  optAll.value = "";
  optAll.textContent = "Todas";
  select.appendChild(optAll);

  // Normaliza values a array de strings
  let list = [];
  if (Array.isArray(values)) {
    list = values.map(String);
  } else if (values && typeof values === "object") {
    // Por si el backend devuelve un objeto {valor:true}
    list = Object.keys(values);
  }

  for (const val of list) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = val;
    select.appendChild(opt);
  }

  // Busca si el valor previo existe (sin usar iterables)
  let hasPrev = false;
  for (let i = 0; i < select.options.length; i++) {
    if (select.options[i].value === prev) { hasPrev = true; break; }
  }
  select.value = hasPrev ? prev : "";

  select.disabled = select.options.length <= 1;
}

/** Sincroniza cascadas desde el backend (no manda inv_meta/inv_google) */
export async function syncCascadingFilters() {
  try {
    _filtersUpdating = true;

    // Deshabilita mientras carga (sólo selects)
    filtrosKeys.forEach((k) => {
      const el = document.getElementById(k);
      if (el && String(el.tagName).toUpperCase() === "SELECT") {
        el.disabled = true;
        el.title = "Actualizando…";
      }
    });

    // Lee filtros y quita inversiones para /filtros
    const current = getFiltros();
    const filtrosParaAPI = { ...current };
    delete filtrosParaAPI.inv_meta;
    delete filtrosParaAPI.inv_google;

    const data = await fetchFiltros(filtrosParaAPI);

    // Pobla sólo selects (inputs se quedan como están)
    filtrosKeys.forEach((k) => {
      const el = document.getElementById(k);
      if (!el) return;
      if (String(el.tagName).toUpperCase() === "SELECT") {
        populateSelect(el, data?.[k] || [], el.value);
        el.title = "";
      }
    });

  } catch (e) {
    console.error("Error sincronizando filtros:", e);
  } finally {
    _filtersUpdating = false;
    // Rehabilita controles
    filtrosKeys.forEach((k) => {
      const el = document.getElementById(k);
      if (el && String(el.tagName).toUpperCase() === "SELECT") {
        el.disabled = false;
        el.title = "";
      }
    });
  }
}

/** Wire de eventos: change para selects; input para inversiones (y otros inputs) */
export function wireEventos(onChangeAll, setNivel) {
  // Botones de nivel
  const btnDepto  = document.getElementById("nivel-departamento");
  const btnCiudad = document.getElementById("nivel-ciudad");
  if (btnDepto)  btnDepto.addEventListener("click", () => setNivel("departamento"));
  if (btnCiudad) btnCiudad.addEventListener("click", () => setNivel("ciudad"));

  // Debounce de cambios
  const onFilterChange = debounce(async () => {
    if (_filtersUpdating) return;
    await syncCascadingFilters();
    await onChangeAll();
  }, 200);

  // Para cada filtro registrado elige evento adecuado
  filtrosKeys.forEach((key) => {
    const el = document.getElementById(key);
    if (!el) return;
    const isSelect = String(el.tagName).toUpperCase() === "SELECT";
    el.addEventListener(isSelect ? "change" : "input", onFilterChange);
  });

  // Asegura listeners para inputs de inversión aunque no estén en filtrosKeys
  EXTRA_INPUTS.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", onFilterChange);
  });
}
