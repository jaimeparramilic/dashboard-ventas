// backend/routes/ventas_agregadas.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const router = express.Router();

router.get('/', (req, res) => {
  const groupBy = req.query.group_by || 'ciudad';
  const filtros = { ...req.query };
  delete filtros.group_by;

  const acumulador = {};

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
        const clave = row[groupBy] || 'Sin dato';
        const total = parseFloat(row.total) || 0;
        if (!acumulador[clave]) {
          acumulador[clave] = 0;
        }
        acumulador[clave] += total;
      }
    })
    .on('end', () => {
      const resultado = Object.entries(acumulador).map(([key, total]) => ({
        [groupBy]: key,
        total
      }));
      res.json(resultado);
    });
});

module.exports = router;
