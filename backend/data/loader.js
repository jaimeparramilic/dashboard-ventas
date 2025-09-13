// backend/data/loader.js
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

let DATA = null;
let LOADING = null;

function pickCsvPath() {
  const a = path.join(__dirname, 'ventas_limpias.csv');
  const b = path.join(__dirname, 'ventas_geolocalizadas.csv');
  return fs.existsSync(a) ? a : (fs.existsSync(b) ? b : null);
}

async function loadOnce() {
  if (DATA) return DATA;
  if (LOADING) return LOADING;

  const csvPath = pickCsvPath();
  if (!csvPath) throw new Error('CSV no encontrado (ni ventas_limpias.csv ni ventas_geolocalizadas.csv)');

  LOADING = new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(csvPath)
      .pipe(csv())
      .on('data', (r) => rows.push(r))
      .on('end', () => { DATA = rows; resolve(DATA); })
      .on('error', (e) => reject(e));
  });

  return LOADING;
}

module.exports = { loadOnce };
