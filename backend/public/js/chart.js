// chart.js
import { fetchSeries } from "./api.js";

export async function cargarGrafico(getFiltros, loadersRef) {
  const canvas = document.getElementById("chartVentas");
  if (!canvas) return;
  if (!loadersRef.series) loadersRef.series = loadersRef.make(canvas.parentElement);

  const signal = new AbortController().signal; // simple guard local

  try {
    loadersRef.series.show("Cargando serie…");
    const raw = await fetchSeries(getFiltros());

    const agregados = {};
    (raw || []).forEach((d) => {
      const mes = (d.fecha || "").slice(0, 7); // YYYY-MM
      if (!mes) return;
      agregados[mes] = (agregados[mes] || 0) + (Number(d.total) || 0);
    });

    const labelsISO = Object.keys(agregados).sort();
    const valores = labelsISO.map((k) => agregados[k]);
    const labelsBonitos = labelsISO.map((ym) => {
      const date = new Date(`${ym}-01T00:00:00`);
      return date.toLocaleDateString("es-CO", { month: "long", year: "numeric" });
    });

    canvas.height = 420;
    const ctx = canvas.getContext("2d");
    if (window.__chart && typeof window.__chart.destroy === 'function') window.__chart.destroy();
    if (window.Chart) {
      window.__chart = new Chart(ctx, {
        type: "line",
        data: {
          labels: labelsBonitos,
          datasets: [{
            label: "Ventas mensuales",
            data: valores,
            borderColor: "#ffffff",
            backgroundColor: "rgba(255,255,255,0.15)",
            fill: true,
            tension: 0.3,
            borderWidth: 2,
            pointRadius: 3,
            pointHoverRadius: 5,
          }],
        },
        options: {
          responsive: true,
          animation: { duration: 350 },
          scales: {
            x: { ticks: { color: "#fff" }, grid: { color: "rgba(255,255,255,0.08)" } },
            y: {
              beginAtZero: true,
              ticks: { color: "#fff", callback: (v) => "$" + Number(v).toLocaleString() },
              grid: { color: "rgba(255,255,255,0.08)" },
            },
          },
          plugins: {
            legend: { labels: { color: "#fff" } },
            tooltip: { callbacks: { label: (ctx) => "Ventas: $" + Number(ctx.parsed.y).toLocaleString() } },
          },
        },
      });
    }
  } catch (e) {
    console.error("Serie error:", e);
  } finally {
    loadersRef.series.hide();
  }
}
