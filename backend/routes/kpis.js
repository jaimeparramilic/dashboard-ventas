// backend/routes/kpis.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const router = express.Router();

router.get('/', (req, res) => {
  let totalVentas = 0;
  let totalUnidades = 0;
  let categorias = new Set();

  const filtros = { ...req.query };

  fs.createReadStream(path.join(__dirname, '../data/ventas_limpias.csv'))
    .pipe(csv())
    .on('data', (row) => {
      let incluir = true;
      for (const key in filtros) {
        if (filtros[key] && row[key] !== filtros[key]) {
          incluir = false;
        }
      }

      if (incluir) {
        totalVentas += parseFloat(row.total) || 0;
        totalUnidades += parseInt(row.cantidad) || 0;
        if (row.categoria) categorias.add(row.categoria);
      }
    })
    .on('end', () => {
      const ticketPromedio = totalUnidades > 0 ? totalVentas / totalUnidades : 0;
      res.json({
        total_ventas: totalVentas,
        unidades_vendidas: totalUnidades,
        ticket_promedio: ticketPromedio,
        categorias_activas: categorias.size
      });
    });
});

module.exports = router;
