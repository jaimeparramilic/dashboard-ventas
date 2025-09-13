// backend/routes/ventas_mapa.js
const express = require('express');
const fs = require('fs');
const path = require('path');

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
    .replace(/^ciudad de /, '')
    // aliases comunes Colombia
    .replace(/^bogota d c$/, 'bogota')
    .replace(/^bogota dc$/, 'bogota')
    .replace(/^cartagena de indias$/, 'cartagena')
    .replace(/^santa marta d t c h$/, 'santa marta');
}

/* ---------------- Bogotá helpers ---------------- */
const BOGOTA_CANON = 'bogota';
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

/* ======================================================================
   MAPEOS DESDE CSV (flexible)
   - Por defecto: backend/data/mapping.csv
   - Override por env: MAP_MAPPING_FILE=/ruta/a/tu/mapping.csv

   Este loader está adaptado para tu CSV generado:
   columnas típicas (cualquiera de estos alias funciona):
   Fuente (ventas):
     - ciudad:      ciudad | municipio | mpio | city | ciudad_src | ciudad_venta
     - departamento:departamento | dpto | dep | dept | departamento_src
   “Oficial” (para el mapa):
     - ciudad_oficial:       ciudad_geo | ciudad_oficial | city_official | adm2_name | nombre_mpio_oficial | geo_city_shapename
     - departamento_oficial: departamento_geo | departamento_oficial | dept_official | adm1_name | nombre_dpto_oficial | geo_dept_name
     - shapeID (opcional):   shapeid | geo_shapeid

   Si tu CSV es el que generé (ventas_a_ciudades_geo_mapping_final.csv) también funciona:
     - Usará geo_city_shapeName, geo_dept_name, geo_shapeID si existen.
====================================================================== */
const DEFAULT_MAPPING_FILE = path.join(__dirname, '..', 'data', 'mapping.csv');
const MAPPING_FILE = process.env.MAP_MAPPING_FILE
  ? path.resolve(process.env.MAP_MAPPING_FILE)
  : DEFAULT_MAPPING_FILE;

function parseCSVFlexible(csvText) {
  // Detecta separador (coma o punto y coma) con heurística por primera línea
  const firstLine = csvText.split(/\r?\n/).find(l => l.trim().length > 0) || '';
  const sep = (firstLine.match(/;/g)?.length || 0) > (firstLine.match(/,/g)?.length || 0) ? ';' : ',';

  const rows = [];
  let headers = [];
  for (const rawLine of csvText.split(/\r?\n/)) {
    if (!rawLine || !rawLine.trim()) continue;

    // Parser simple con comillas dobles
    const parts = [];
    let cur = '', inQ = false;
    for (let i = 0; i < rawLine.length; i++) {
      const ch = rawLine[i];
      if (ch === '"') {
        if (inQ && rawLine[i+1] === '"') { cur += '"'; i++; } // escape ""
        else { inQ = !inQ; }
      } else if (ch === sep && !inQ) {
        parts.push(cur); cur = '';
      } else {
        cur += ch;
      }
    }
    parts.push(cur);

    if (headers.length === 0) {
      headers = parts.map(h => canonBase(h));
    } else {
      const obj = {};
      for (let i = 0; i < headers.length; i++) obj[headers[i]] = parts[i] ?? '';
      rows.push(obj);
    }
  }
  return { headers, rows };
}

function loadMappingCSVOnce() {
  let text;
  try {
    text = fs.readFileSync(MAPPING_FILE, 'utf8');
  } catch (e) {
    console.warn('[ventas_mapa] No se encontró CSV de mapeo; fallback:', MAPPING_FILE);
    return {
      deptCanon2Official: new Map(),
      cityCanon2Official: new Map(),
      bogotaDeptOfficial: 'Bogotá D.C.',
      bogotaCityOfficial: 'Bogotá D.C.',
    };
  }

  const { headers, rows } = parseCSVFlexible(text);

  // Helpers para encontrar headers por alias
  const has = (h) => headers.includes(canonBase(h));
  const findHeader = (aliasList) => aliasList.map(canonBase).find(h => headers.includes(h));

  // Fuente (ventas)
  const SRC_CITY = findHeader(['ciudad','municipio','mpio','city','ciudad_src','ciudad_venta']);
  const SRC_DEPT = findHeader(['departamento','dpto','dep','dept','departamento_src']);

  // Oficiales (para el mapa)
  const OFF_CITY = findHeader(['ciudad_geo','ciudad_oficial','city_official','adm2_name','nombre_mpio_oficial','geo_city_shapename','geo_city_shapeName']);
  const OFF_DEPT = findHeader(['departamento_geo','departamento_oficial','dept_official','adm1_name','nombre_dpto_oficial','geo_dept_name']);
  const OFF_SHID = findHeader(['shapeid','geo_shapeid','shape_id']);

  if (!SRC_CITY || !SRC_DEPT) {
    console.warn('[ventas_mapa] CSV mapping: faltan columnas de fuente (ciudad/departamento). Se intentará fallback con lo disponible.');
  }
  if (!OFF_CITY || !OFF_DEPT) {
    console.warn('[ventas_mapa] CSV mapping: faltan columnas oficiales (ciudad_oficial/departamento_oficial). Se usará fallback parcial.');
  }

  const deptCanon2Official = new Map();
  const cityCanon2Official = new Map();

  for (const r of rows) {
    const srcCityRaw = SRC_CITY ? r[SRC_CITY] : '';
    const srcDeptRaw = SRC_DEPT ? r[SRC_DEPT] : '';

    const offCityRaw = OFF_CITY ? r[OFF_CITY] : '';
    const offDeptRaw = OFF_DEPT ? r[OFF_DEPT] : '';
    const shapeIDRaw = OFF_SHID ? r[OFF_SHID] : '';

    const cCanon = canonCity(srcCityRaw);
    let dCanon = canonDept(srcDeptRaw);

    // Bogotá: fuerza depto "bogota" si la ciudad lo es
    if (isBogotaCityCanon(cCanon)) dCanon = BOGOTA_CANON;

    // Nombres "bonitos" para salida
    const offDeptName = (offDeptRaw && String(offDeptRaw).trim())
      ? String(offDeptRaw).trim()
      : (dCanon === BOGOTA_CANON ? 'Bogotá D.C.' : (srcDeptRaw || dCanon));

    const offCityName = (offCityRaw && String(offCityRaw).trim())
      ? String(offCityRaw).trim()
      : (cCanon ? (srcCityRaw || cCanon) : '');

    if (dCanon) {
      if (!deptCanon2Official.has(dCanon)) deptCanon2Official.set(dCanon, offDeptName);
    }
    if (cCanon && dCanon) {
      const keyCity = `${cCanon}__${dCanon}`;
      if (!cityCanon2Official.has(keyCity)) {
        cityCanon2Official.set(keyCity, { city: offCityName, dept: offDeptName, shapeID: shapeIDRaw || null });
      }
    }
  }

  // Asegura Bogotá
  if (!deptCanon2Official.has(BOGOTA_CANON)) deptCanon2Official.set(BOGOTA_CANON, 'Bogotá D.C.');

  const OFFICIAL = {
    deptCanon2Official,
    cityCanon2Official,
    bogotaDeptOfficial: 'Bogotá D.C.',
    bogotaCityOfficial: 'Bogotá D.C.',
  };
  return OFFICIAL;
}

// Carga única al iniciar el proceso
const OFFICIAL = loadMappingCSVOnce();

/* ---------------- Cache simple en memoria ---------------- */
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
    // 1) Normaliza group_by
    const groupByRaw = String(req.query.group_by || '').toLowerCase();
    const groupBy = (groupByRaw === 'departamento') ? 'departamento' : 'ciudad';

    // 2) Caché
    try {
      const cacheKey = cacheKeyFromQuery(req.query);
      const hit = MAPA_CACHE.get(cacheKey);
      if (hit && (Date.now() - hit.t) < MAPA_TTL) return res.json(hit.data);
    } catch (e) {
      console.warn('[ventas_mapa] cache read warn:', e?.message || e);
    }

    // 3) Datos crudos
    const rows = await req.app.locals.loadData();
    if (!Array.isArray(rows)) return res.status(500).json({ error: 'Datos inválidos' });

    // 4) Filtro
    const filtro = buildFiltroFn(req.query);

    // 5) Agregación
    const aggDept = new Map();           // deptCanon -> total
    const aggCity = new Map();           // cityCanon__deptCanon -> total

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

    // 6) Salida con mapeo oficial (incluye shapeID si está en mapping)
    let out;
    if (groupBy === 'departamento') {
      out = [];
      for (const [dCanon, total] of aggDept.entries()) {
        const nombreDept = OFFICIAL.deptCanon2Official.get(dCanon)
          || (dCanon === BOGOTA_CANON ? OFFICIAL.bogotaDeptOfficial : dCanon);
        out.push({ departamento: nombreDept, total });
      }
    } else {
      out = [];
      for (const [key, total] of aggCity.entries()) {
        const [cCanon, dCanon] = key.split('__');

        const mapping = OFFICIAL.cityCanon2Official.get(key);
        if (mapping) {
          const row = { departamento: mapping.dept, ciudad: mapping.city, total };
          if (mapping.shapeID) row.shapeID = mapping.shapeID;
          out.push(row);
          continue;
        }
        // Bogotá por si acaso
        if (dCanon === BOGOTA_CANON && isBogotaCityCanon(cCanon)) {
          out.push({ departamento: OFFICIAL.bogotaDeptOfficial, ciudad: OFFICIAL.bogotaCityOfficial, total });
          continue;
        }
        // Fallback legible si no hay mapeo
        const deptNombre = OFFICIAL.deptCanon2Official.get(dCanon) || (dCanon === BOGOTA_CANON ? 'Bogotá D.C.' : dCanon);
        out.push({ departamento: deptNombre, ciudad: cCanon, total });
      }
    }

    // 7) Cache write
    try {
      const cacheKey = cacheKeyFromQuery(req.query);
      MAPA_CACHE.set(cacheKey, { t: Date.now(), data: out });
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
