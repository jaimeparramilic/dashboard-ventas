// main.js
import { makeOverlayWithProgress } from "./utils.js";
import { exportCSV } from "./api.js";
import { wireEventos, syncCascadingFilters, getFiltros } from "./filters.js";
import { cargarKPIs } from "./kpis.js";
import { cargarGrafico } from "./chart.js";
import { initMapaSiNecesario, cambiarNivelConLoader } from "./map.js"; // ← un solo import desde map.js

// Estado UI loaders (por si los usas en otras vistas)
const loaders = {
  make: (parentEl) => makeOverlayWithProgress(parentEl, { dark: true }),
  series: null,
  mapa: null,
};

// Nivel de mapa (persistido en window para que filters.js lo consulte/actualice)
window.nivelMapa = "departamento";

/** Decide el nivel por filtros y pinta con loader */
async function onChangeAll() {
  const filtros = getFiltros();
  const nivel = filtros.ciudad ? "ciudad" : "departamento";
  // guarda el nivel actual para consistencia con botones
  window.nivelMapa = nivel;
  await cambiarNivelConLoader(nivel, getFiltros);
}

/** Cambia el nivel explícitamente (botones) y pinta con loader */
async function setNivel(nivel) {
  const nuevo = (nivel === "ciudad") ? "ciudad" : "departamento";
  if (window.nivelMapa === nuevo) {
    // mismo nivel: repinta con loader para refrescar datos actuales
    await cambiarNivelConLoader(nuevo, getFiltros);
    return;
  }
  window.nivelMapa = nuevo;
  await cambiarNivelConLoader(nuevo, getFiltros);
}

/** Botones “extra” de la UI */
function wireBotonesExtras() {
  const btnKPIs   = document.getElementById("btnKPIs");
  const btnSerie  = document.getElementById("btnSerie");
  const btnMapa   = document.getElementById("btnMapa");
  const btnExport = document.getElementById("btnExport");

  if (btnKPIs)  btnKPIs.addEventListener("click", () => cargarKPIs(getFiltros));
  if (btnSerie) btnSerie.addEventListener("click", () => cargarGrafico(getFiltros, loaders));

  // Si quieres refrescar TODO al ir a la pestaña de mapa:
  if (btnMapa)  btnMapa.addEventListener("click", async () => {
    await cargarKPIs(getFiltros);
    await cambiarNivelConLoader(window.nivelMapa, getFiltros); // ← antes llamabas renderCoropletas directo
    await cargarGrafico(getFiltros, loaders);
  });

  if (btnExport) btnExport.addEventListener("click", async () => {
    const blob = await exportCSV(getFiltros());
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "ventas_export.csv"; a.click();
    URL.revokeObjectURL(url);
  });
}

/** Bootstrap de la app */
async function bootstrap() {
  initMapaSiNecesario();
  // sincroniza selects desde backend al arrancar
  await syncCascadingFilters();

  // Enlaza filtros y botones (filters.js llamará onChangeAll y usará setNivel en sus botones)
  wireEventos(onChangeAll, setNivel);
  wireBotonesExtras();

  // Primer render con el nivel por defecto
  await cambiarNivelConLoader(window.nivelMapa, getFiltros);
}

window.addEventListener("load", bootstrap);
