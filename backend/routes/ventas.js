// backend/routes/ventas.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const router = express.Router();

router.get('/', (req, res) => {
  const results = [];

  const filtros = {
    ciudad: req.query.ciudad,
    departamento: req.query.departamento,
    macrocategoria: req.query.macrocategoria,
    categoria: req.query.categoria,
    subcategoria: req.query.subcategoria,
    segmento: req.query.segmento,
    marca: req.query.marca
  };

  fs.createReadStream(path.join(__dirname, '../data/ventas_limpias.csv'))
    .pipe(csv())
    .on('data', (row) => {
      let incluir = true;
      for (const key in filtros) {
        if (filtros[key] && row[key] !== filtros[key]) {
          incluir = false;
          break;
        }
      }
      if (incluir) {
        results.push({
          ciudad: row.ciudad,
          departamento: row.departamento,
          valor: parseFloat(row.valor_total) || 0
        });
      }
    })
    .on('end', () => {
      const agregados = {};

      results.forEach(({ ciudad, departamento, valor }) => {
        const key = `${ciudad}__${departamento}`;
        if (!agregados[key]) {
          agregados[key] = {
            ciudad,
            departamento,
            total: 0
          };
        }
        agregados[key].total += valor;
      });

      const respuesta = Object.values(agregados);
      res.json(respuesta);
    });
});

module.exports = router;

