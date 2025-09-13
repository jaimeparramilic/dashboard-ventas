// backend/routes/ventas_mapa.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

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

/* ---------------- GeoJSON index (cache) ---------------- */
let GEO = null;

function pick(o, keys) {
  for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k];
  return undefined;
}
function getDeptPropName(props) {
  return pick(props, [
    'shapeName','NAME_1','NOMBRE_DPT','NOMBRE_DEP','DEPARTAMEN','DPTO_CNMBR',
    'departamento','DEPARTAMENTO','dpto','dpt','name'
  ]);
}
function getCityPropName(props) {
  return pick(props, [
    'shapeName','NAME_2','NOMBRE_MPIO','MPIO_CNMBR','municipio','MUNICIPIO',
    'ciudad','CIUDAD','NOMBRE_CIU','name'
  ]);
}

function loadGeoOnce() {
  if (GEO) return GEO;

  const deptPaths = [
    path.join(__dirname, '../public/geo/departamentos.geojson'),
    path.join(__dirname, '../../public/geo/departamentos.geojson'),
    path.join(process.cwd(), 'public/geo/departamentos.geojson'),
  ];
  const cityPaths = [
    path.join(__dirname, '../public/geo/ciudades.geojson'),
    path.join(__dirname, '../../public/geo/ciudades.geojson'),
    path.join(process.cwd(), 'public/geo/ciudades.geojson'),
  ];

  const deptFile = deptPaths.find(fs.existsSync);
  const cityFile = cityPaths.find(fs.existsSync);
  if (!deptFile || !cityFile) throw new Error('GeoJSON locales no encontrados en /public/geo/');

  const deptos = JSON.parse(fs.readFileSync(deptFile, 'utf8'));
  const cities = JSON.parse(fs.readFileSync(cityFile, 'utf8'));

  // Índices
  const deptCanon2Official = new Map();             // deptCanon -> deptOficial
  const cityCanon2Official = new Map();             // cityCanon__deptCanon -> { city, dept }
  let bogotaDeptOfficial = null;                    // nombre oficial de Bogotá (ADM1)
  let bogotaCityOfficial = null;                    // nombre oficial de Bogotá (ADM2), si existe

  // Departamentos
  for (const f of (deptos.features || [])) {
    const off = String(getDeptPropName(f.properties) || '').trim();
    if (!off) continue;
    const dCanon = canonDept(off);
    if (!deptCanon2Official.has(dCanon)) deptCanon2Official.set(dCanon, off);
    if (dCanon === BOGOTA_CANON) bogotaDeptOfficial = off; // <- dinámico del geo
  }

  // Ciudades/municipios
  for (const f of (cities.features || [])) {
    const offCity = String(getCityPropName(f.properties) || '').trim();
    const offDept = String(getDeptPropName(f.properties) || '').trim();
    if (!offCity || !offDept) continue;

    const cCanon = canonCity(offCity);
    const dCanon = canonDept(offDept);
    const key = `${cCanon}__${dCanon}`;
    if (!cityCanon2Official.has(key)) {
      cityCanon2Official.set(key, { city: offCity, dept: offDept });
    }
    // Si ADM2 trae Bogotá como municipio bajo Bogotá D.C., lo guardamos
    if (dCanon === BOGOTA_CANON && (cCanon === 'bogota' || cCanon === 'bogota dc' || cCanon === 'bogota d c')) {
      bogotaCityOfficial = offCity;
    }
  }

  // Si por alguna razón no encontramos Bogotá en ADM1, no hardcodeamos: usamos un fallback seguro
  if (!bogotaDeptOfficial) {
    // Busca algún nombre que contenga "bogotá" en oficiales
    for (const off of deptCanon2Official.values()) {
      if (canonDept(off).startsWith('bogota')) { bogotaDeptOfficial = off; break; }
    }
    // último recurso:
    if (!bogotaDeptOfficial) bogotaDeptOfficial = 'Bogotá D.C.';
  }

  // Si ADM2 no trae ciudad Bogotá, al pintar ciudad usaremos el nombre de depto como city oficial (mejor UX)
  if (!bogotaCityOfficial) bogotaCityOfficial = bogotaDeptOfficial;

  GEO = { deptCanon2Official, cityCanon2Official, bogotaDeptOfficial, bogotaCityOfficial };
  return GEO;
}

/* ---------------- Filtro a partir de query ---------------- */
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

/* --------------------------- Ruta --------------------------- */
router.get('/', (req, res) => {
  let geo;
  try { geo = loadGeoOnce(); }
  catch (e) {
    console.error('[ventas_mapa] Geo error:', e);
    return res.status(500).json({ error: 'GeoJSON no disponible' });
  }

  const groupBy = String(req.query.group_by || '').toLowerCase(); // 'departamento' | 'ciudad' | ''
  const filtro = buildFiltroFn(req.query);

  const aggDept = new Map(); // deptCanon -> total
  const aggCity = new Map(); // cityCanon__deptCanon -> total

  const csvPath = path.join(__dirname, '../data/ventas_limpias.csv');
  if (!fs.existsSync(csvPath)) {
    return res.status(404).json({ error: 'ventas_limpias.csv no encontrado' });
  }

  fs.createReadStream(csvPath)
    .pipe(csv())
    .on('data', (row) => {
      try {
        if (!filtro(row)) return;

        const monto = Number(row.total ?? row.valor_total ?? row.valor ?? 0) || 0;

        // Normaliza y aplica regla Bogotá
        const cityCanon = canonCity(row.ciudad);
        const deptCanon = isBogotaCityCanon(cityCanon) ? BOGOTA_CANON : canonDept(row.departamento);

        if (groupBy === 'departamento') {
          aggDept.set(deptCanon, (aggDept.get(deptCanon) || 0) + monto);
        } else { // 'ciudad' o default
          const key = `${cityCanon}__${deptCanon}`;
          aggCity.set(key, (aggCity.get(key) || 0) + monto);
        }
      } catch (_) { /* ignora fila defectuosa */ }
    })
    .on('end', () => {
      if (groupBy === 'departamento') {
        const out = [];
        for (const [dCanon, total] of aggDept.entries()) {
          let dOff = geo.deptCanon2Official.get(dCanon);
          // Garantiza que Bogotá siempre salga con el nombre oficial del geo
          if (dCanon === BOGOTA_CANON) dOff = geo.bogotaDeptOfficial;
          if (!dOff) dOff = dCanon;
          out.push({ departamento: dOff, total });
        }
        return res.json(out);
      }

      // group_by=ciudad (o default)
      const out = [];
      for (const [key, total] of aggCity.entries()) {
        const [cCanon, dCanon] = key.split('__');

        // Intenta mapping completo ciudad+depto
        const mapping = geo.cityCanon2Official.get(key);
        if (mapping) {
          out.push({ departamento: mapping.dept, ciudad: mapping.city, total });
          continue;
        }

        // Si es Bogotá y no hay feature ADM2, usamos el nombre oficial detectado
        if (dCanon === BOGOTA_CANON && isBogotaCityCanon(cCanon)) {
          out.push({ departamento: geo.bogotaDeptOfficial, ciudad: geo.bogotaCityOfficial, total });
          continue;
        }

        // Fallback genérico: al menos devuelve el dpto oficial si existe
        const dOff = geo.deptCanon2Official.get(dCanon) || dCanon;
        out.push({ departamento: dOff, ciudad: cCanon, total });
      }

      res.json(out);
    });
});

module.exports = router;

