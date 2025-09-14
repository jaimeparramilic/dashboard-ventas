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

/** Decide el nivel por filtros y pinta TODO (mapa + KPIs + serie) */
async function onChangeAll() {
  const filtros = getFiltros();
  const nivel = filtros.ciudad ? "ciudad" : "departamento";
  window.nivelMapa = nivel;

  await cargarKPIs(getFiltros);
  await cambiarNivelConLoader(nivel, getFiltros);
  await cargarGrafico(getFiltros, loaders);
}

/** Cambia el nivel explícitamente (botones) y pinta con loader */
async function setNivel(nivel) {
  const nuevo = (nivel === "ciudad") ? "ciudad" : "departamento";
  window.nivelMapa = nuevo;
  await cargarKPIs(getFiltros);
  await cambiarNivelConLoader(nuevo, getFiltros);
  await cargarGrafico(getFiltros, loaders);
}

/** Botones “extra” de la UI */
function wireBotonesExtras() {
  const btnKPIs   = document.getElementById("btnKPIs");
  const btnSerie  = document.getElementById("btnSerie");
  const btnMapa   = document.getElementById("btnMapa");
  const btnExport = document.getElementById("btnExport");

  if (btnKPIs)  btnKPIs.addEventListener("click", () => cargarKPIs(getFiltros));
  if (btnSerie) btnSerie.addEventListener("click", () => cargarGrafico(getFiltros, loaders));

  if (btnMapa)  btnMapa.addEventListener("click", async () => {
    await cargarKPIs(getFiltros);
    await cambiarNivelConLoader(window.nivelMapa, getFiltros);
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
  await cargarKPIs(getFiltros);
  await cambiarNivelConLoader(window.nivelMapa, getFiltros);
  await cargarGrafico(getFiltros, loaders);
}

window.addEventListener("load", bootstrap);

/* ==== Exponer a window para los handlers inline del HTML (aplicar()) ==== */
window.cargarKPIs   = () => cargarKPIs(getFiltros);
window.cargarGrafico = () => cargarGrafico(getFiltros, loaders);
// Si en el HTML llamas renderCoropletas(), expón un wrapper que use el flujo nuevo:
window.renderCoropletas = async () => cambiarNivelConLoader(window.nivelMapa, getFiltros);
// También expón setNivel si lo necesitas en botones inline:
window.changeNivel = setNivel;
