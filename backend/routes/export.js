// backend/routes/export.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { createObjectCsvWriter } = require('csv-writer');
const router = express.Router();

router.post('/', (req, res) => {
  const filtros = req.body || {};
  const rows = [];

  const csvPath = path.join(__dirname, '../data/ventas_limpias.csv');
  if (!fs.existsSync(csvPath)) {
    return res.status(500).json({ error: 'Archivo de datos no encontrado' });
  }

  fs.createReadStream(csvPath)
    .pipe(csv())
    .on('data', (row) => {
      let incluir = true;
      for (const key in filtros) {
        if (filtros[key] && row[key] !== filtros[key]) {
          incluir = false;
        }
      }
      if (incluir) rows.push(row);
    })
    .on('end', async () => {
      if (rows.length === 0) {
        return res.status(404).json({ error: 'No se encontraron datos con esos filtros' });
      }

      const exportPath = path.join(__dirname, '../data/ventas_export.csv');
      const headers = Object.keys(rows[0]).map((col) => ({ id: col, title: col }));

      const csvWriter = createObjectCsvWriter({
        path: exportPath,
        header: headers
      });

      try {
        await csvWriter.writeRecords(rows);
        res.download(exportPath, 'ventas_export.csv', (err) => {
          if (err) {
            console.error('Error al enviar el archivo:', err);
            res.status(500).send('Error al generar descarga');
          }
        });
      } catch (err) {
        console.error('Error al escribir CSV:', err);
        res.status(500).send('Error al procesar CSV');
      }
    })
    .on('error', (err) => {
      console.error('Error de lectura:', err);
      res.status(500).send('Error al leer archivo fuente');
    });
});

module.exports = router;
