// backend/routes/filtros.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

const router = express.Router();

// Orden/llaves de los filtros (incluye 'segmento' por compatibilidad con tu CSV)
const KEYS = ['departamento','ciudad','macrocategoria','categoria','subcategoria','segmento','marca'];

// Normaliza para comparar (quita acentos, espacios extra, minúsculas)
const canon = (s) => String(s ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

// Carga CSV (usa cache en app.locals si existe; si no, cache local)
async function loadRows(req) {
  if (req.app?.locals?.loadData) return await req.app.locals.loadData();

  if (loadRows._cache) return loadRows._cache;

  const csvPath = path.join(__dirname, '../data/ventas_limpias.csv');
  if (!fs.existsSync(csvPath)) throw new Error('ventas_limpias.csv no encontrado');

  loadRows._cache = await new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(csvPath)
      .pipe(csv())
      .on('data', (r) => rows.push(r))
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
  return loadRows._cache;
}

// Devuelve una función que valida si una fila pasa los filtros seleccionados
function buildFilter(query) {
  // Solo tomamos llaves conocidas
  const want = {};
  for (const k of KEYS) if (query[k]) want[k] = query[k];

  // Comparación por forma canónica
  const wantCanon = {};
  for (const k of Object.keys(want)) wantCanon[k] = canon(want[k]);

  return (row) => {
    for (const k of Object.keys(wantCanon)) {
      if (canon(row[k]) !== wantCanon[k]) return false;
    }
    return true;
  };
}

router.get('/', async (req, res) => {
  try {
    const rows = await loadRows(req);
    const pass = buildFilter(req.query);

    // Filtra con lo ya seleccionado
    const filtered = rows.filter(pass);

    // Para evitar duplicados por mayúsculas/acentos, mapeamos canon->original
    const maps = {};
    for (const k of KEYS) maps[k] = new Map();

    for (const r of filtered) {
      for (const k of KEYS) {
        const v = r[k];
        if (v == null || v === '') continue;
        const c = canon(v);
        if (!maps[k].has(c)) maps[k].set(c, String(v));
      }
    }

    // Construye respuesta ordenada alfabéticamente
    const out = {};
    for (const k of KEYS) {
      out[k] = Array.from(maps[k].values()).sort((a,b)=>a.localeCompare(b,'es'));
    }

    res.json(out);
  } catch (err) {
    console.error('[filtros] error:', err);
    res.status(500).json({ error: 'No se pudieron calcular filtros' });
  }
});

module.exports = router;
