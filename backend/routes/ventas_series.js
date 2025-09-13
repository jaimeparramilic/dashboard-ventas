// backend/routes/ventas_series.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const router = express.Router();

router.get('/', (req, res) => {
  const filtros = { ...req.query };
  const acumulado = {};

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
        const fecha = row.fecha?.split('T')[0];
        const total = parseFloat(row.total) || 0;
        if (!acumulado[fecha]) {
          acumulado[fecha] = 0;
        }
        acumulado[fecha] += total;
      }
    })
    .on('end', () => {
      const resultado = Object.entries(acumulado).map(([fecha, total]) => ({ fecha, total }));
      resultado.sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
      res.json(resultado);
    });
});

module.exports = router;
