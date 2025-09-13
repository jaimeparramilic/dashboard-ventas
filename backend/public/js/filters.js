// filters.js
import { filtrosKeys, debounce } from "./utils.js";
import { fetchFiltros } from "./api.js";

let _filtersUpdating = false;

export function getFiltros() {
  const filtros = {};
  filtrosKeys.forEach((key) => {
    const el = document.getElementById(key);
    if (el && el.value) filtros[key] = el.value;
  });
  return filtros;
}

export function populateSelect(select, values, previousValue) {
  if (!select) return;
  const prev = previousValue ?? select.value;
  select.innerHTML = "<option value=''>Todas</option>";
  (values || []).forEach((val) => {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = val;
    select.appendChild(opt);
  });
  if ([...select.options].some(o => o.value === prev)) {
    select.value = prev;
  } else {
    select.value = "";
  }
  select.disabled = select.options.length <= 1;
}

export async function syncCascadingFilters() {
  try {
    _filtersUpdating = true;
    filtrosKeys.forEach((k) => {
      const el = document.getElementById(k);
      if (el) { el.disabled = true; el.title = "Actualizando…"; }
    });

    const data = await fetchFiltros(getFiltros());
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

export function wireEventos(onChangeAll, setNivel) {
  // Botones de nivel
  const btnDepto = document.getElementById("nivel-departamento");
  const btnCiudad = document.getElementById("nivel-ciudad");
  if (btnDepto) btnDepto.addEventListener("click", () => setNivel("departamento"));
  if (btnCiudad) btnCiudad.addEventListener("click", () => setNivel("ciudad"));

  // Filtros → cascada + refrescos
  const onFilterChange = debounce(async () => {
    if (_filtersUpdating) return;
    await syncCascadingFilters();
    await onChangeAll();
  }, 200);

  filtrosKeys.forEach((key) => {
    const el = document.getElementById(key);
    if (el) el.addEventListener("change", onFilterChange);
  });
}
