// backend/routes/filtros.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const router = express.Router();

router.get('/', (req, res) => {
  const valores = {
    ciudad: new Set(),
    departamento: new Set(),
    macrocategoria: new Set(),
    categoria: new Set(),
    subcategoria: new Set(),
    segmento: new Set(),
    marca: new Set()
  };

  fs.createReadStream(path.join(__dirname, '../data/ventas_limpias.csv'))
    .pipe(csv())
    .on('data', (row) => {
      for (const key in valores) {
        valores[key].add(row[key]);
      }
    })
    .on('end', () => {
      const resultado = {};
      for (const key in valores) {
        resultado[key] = Array.from(valores[key]).sort();
      }
      res.json(resultado);
    });
});

module.exports = router;
