// backend/routes/ventas_mapa.js
const express = require('express');

const router = express.Router();

/* ---------------- Utils de normalización ---------------- */
function canonBase(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[.,()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function canonDept(name) {
  return canonBase(name)
    .replace(/^departamento del? /, '')
    .replace(/^dpto del? /, '')
    .replace(/ departamento$/, '')
    .replace(/ depto$/, '');
}
function canonCity(name) {
  return canonBase(name)
    .replace(/^municipio de /, '')
    .replace(/^ciudad de /, '');
}

/* ---------------- Bogotá helpers ---------------- */
const BOGOTA_CANON = 'bogota dc';
function isBogotaCityCanon(c) {
  return c === 'bogota' || c === 'bogota d c' || c === 'bogota dc';
}

/* ---------------- Helpers varias ---------------- */
function pick(o, keys) {
  for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k];
  return undefined;
}
function toNumberLoose(x) {
  const s = String(x ?? '').replace(/[^\d.,-]/g, '').trim();
  if (!s) return 0;
  if (s.includes(',') && s.includes('.')) return parseFloat(s.replace(/,/g, ''));
  if (s.includes(',') && !s.includes('.')) return parseFloat(s.replace(/\./g, '').replace(',', '.'));
  return parseFloat(s);
}

/* ---------------- Filtro desde query ---------------- */
function buildFiltroFn(q) {
  const filtros = {
    macrocategoria: q.macrocategoria,
    categoria: q.categoria,
    subcategoria: q.subcategoria,
    segmento: q.segmento,
    marca: q.marca,
    departamento: q.departamento,
    ciudad: q.ciudad,
  };
  const fDeptCanon = filtros.departamento ? canonDept(filtros.departamento) : null;
  const fCityCanon = filtros.ciudad ? canonCity(filtros.ciudad) : null;

  return (row) => {
    for (const k of ['macrocategoria','categoria','subcategoria','segmento','marca']) {
      if (filtros[k] && row[k] !== filtros[k]) return false;
    }
    const rowCityCanon = canonCity(row.ciudad);
    const rowDeptCanon = isBogotaCityCanon(rowCityCanon) ? BOGOTA_CANON : canonDept(row.departamento);
    if (fDeptCanon && rowDeptCanon !== fDeptCanon) return false;
    if (fCityCanon && rowCityCanon !== fCityCanon) return false;
    return true;
  };
}

/* ------------- Mapeo "oficial" (fallback si no hay geo local) ------------- */
// Como ahora el GeoJSON lo cargas desde GCS en el front, aquí usamos nombres canónicos
// y devolvemos strings legibles. Si en el futuro quieres mapear al nombre "oficial"
// del GeoJSON, puedes añadir ese índice aquí.
const OFFICIAL = {
  deptCanon2Official: new Map(),     // vacío: devolvemos el canónico tal cual
  cityCanon2Official: new Map(),     // vacío
  bogotaDeptOfficial: 'Bogotá D.C.',
  bogotaCityOfficial: 'Bogotá D.C.',
};
// Cache simple en memoria para agregados del mapa
const MAPA_CACHE = new Map();
const MAPA_TTL = 5 * 60 * 1000; // 5 minutos

function cacheKeyFromQuery(q) {
  const allow = ['group_by','departamento','ciudad','macrocategoria','categoria','subcategoria','segmento','marca'];
  const obj = {};
  for (const k of allow) if (q[k]) obj[k] = String(q[k]);
  return 'mapa:' + JSON.stringify(obj);
}

/* --------------------------- Ruta --------------------------- */
router.get('/', async (req, res) => {
  try {
    // 1) Índices oficiales desde los GeoJSON (cacheados en memoria)
    let OFFICIAL;
    try {
      OFFICIAL = loadGeoOnce();
    } catch (e) {
      console.error('[ventas_mapa] Geo error:', e);
      return res.status(500).json({ error: 'GeoJSON no disponible' });
    }

    // 2) Normaliza modo de agregación
    const groupByRaw = String(req.query.group_by || '').toLowerCase();
    const groupBy = (groupByRaw === 'departamento') ? 'departamento' : 'ciudad';

    // 3) Caché de respuesta (si configuraste MAPA_CACHE/MAPA_TTL/cacheKeyFromQuery)
    try {
      if (typeof cacheKeyFromQuery === 'function' && MAPA_CACHE) {
        const cacheKey = cacheKeyFromQuery(req.query);
        const hit = MAPA_CACHE.get(cacheKey);
        if (hit && (Date.now() - hit.t) < MAPA_TTL) {
          return res.json(hit.data);
        }
      }
    } catch (e) {
      // no bloquea la petición si el caché falla
      console.warn('[ventas_mapa] cache read warn:', e?.message || e);
    }

    // 4) Carga de datos CSV (cacheado en memoria por tu loader)
    let rows;
    try {
      rows = await req.app.locals.loadData();
    } catch (e) {
      console.error('[ventas_mapa] loadData error:', e);
      return res.status(500).json({ error: 'Error cargando datos' });
    }
    if (!Array.isArray(rows)) {
      return res.status(500).json({ error: 'Datos inválidos' });
    }

    // 5) Filtro según query
    const filtro = buildFiltroFn(req.query);

    // 6) Agregación
    const aggDept = new Map(); // deptCanon -> total
    const aggCity = new Map(); // cityCanon__deptCanon -> total

    for (const row of rows) {
      if (!filtro(row)) continue;

      const monto = toNumberLoose(row.total ?? row.valor_total ?? row.valor ?? 0);
      const cityCanon = canonCity(row.ciudad);
      const deptCanon = isBogotaCityCanon(cityCanon) ? BOGOTA_CANON : canonDept(row.departamento);

      if (groupBy === 'departamento') {
        aggDept.set(deptCanon, (aggDept.get(deptCanon) || 0) + (monto || 0));
      } else {
        const key = `${cityCanon}__${deptCanon}`;
        aggCity.set(key, (aggCity.get(key) || 0) + (monto || 0));
      }
    }

    // 7) Construcción de salida bonita (mapea a nombres oficiales)
    let out;
    if (groupBy === 'departamento') {
      out = [];
      for (const [dCanon, total] of aggDept.entries()) {
        let dOff = OFFICIAL.deptCanon2Official.get(dCanon);
        if (dCanon === BOGOTA_CANON) dOff = OFFICIAL.bogotaDeptOfficial;
        if (!dOff) dOff = dCanon; // fallback legible
        out.push({ departamento: dOff, total });
      }
    } else {
      out = [];
      for (const [key, total] of aggCity.entries()) {
        const [cCanon, dCanon] = key.split('__');

        const mapping = OFFICIAL.cityCanon2Official.get(key);
        if (mapping) {
          out.push({ departamento: mapping.dept, ciudad: mapping.city, total });
          continue;
        }

        if (dCanon === BOGOTA_CANON && isBogotaCityCanon(cCanon)) {
          out.push({ departamento: OFFICIAL.bogotaDeptOfficial, ciudad: OFFICIAL.bogotaCityOfficial, total });
          continue;
        }

        const dOff = OFFICIAL.deptCanon2Official.get(dCanon) || dCanon;
        out.push({ departamento: dOff, ciudad: cCanon, total });
      }
    }

    // 8) Guarda en caché la respuesta (si está disponible)
    try {
      if (typeof cacheKeyFromQuery === 'function' && MAPA_CACHE) {
        const cacheKey = cacheKeyFromQuery(req.query);
        MAPA_CACHE.set(cacheKey, { t: Date.now(), data: out });
      }
    } catch (e) {
      console.warn('[ventas_mapa] cache write warn:', e?.message || e);
    }

    return res.json(out);
  } catch (err) {
    console.error('[ventas_mapa] error:', err);
    return res.status(500).json({ error: 'Error procesando datos de mapa' });
  }
});


module.exports = router;
