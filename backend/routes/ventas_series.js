cd// backend/routes/ventas_series.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

const router = express.Router();

/* ========= Utils (alineados con /kpis) ========= */
function canonBase(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // sin tildes
    .toLowerCase()
    .replace(/[.,()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function canonNoSpaces(s) { return canonBase(s).replace(/\s+/g, ''); }
function canonCity(s) {
  return canonBase(s)
    .replace(/^municipio de /, '')
    .replace(/^ciudad de /, '')
    .replace(/^bogota d c$/, 'bogota')
    .replace(/^bogota dc$/, 'bogota')
    .replace(/^cartagena de indias$/, 'cartagena')
    .replace(/^santa marta d t c h$/, 'santa marta');
}
function canonDept(s) {
  return canonBase(s)
    .replace(/^departamento del? /, '')
    .replace(/^dpto del? /, '')
    .replace(/ departamento$/, '')
    .replace(/ depto$/, '');
}
function isBogotaCityCanon(c) {
  return c === 'bogota' || c === 'bogota dc' || c === 'bogota d c';
}
function toNumberLoose(x) {
  const s = String(x ?? '').replace(/[^\d.,-]/g, '').trim();
  if (!s) return 0;
  if (s.includes(',') && s.includes('.')) return parseFloat(s.replace(/,/g, ''));
  if (s.includes(',') && !s.includes('.')) return parseFloat(s.replace(/\./g, '').replace(',', '.'));
  return parseFloat(s);
}

/** Busca un valor en la fila por lista de posibles nombres de columna (tolerante a espacios/guiones) */
function getField(row, candidates) {
  const map = new Map();
  for (const k of Object.keys(row)) map.set(canonBase(k), row[k]);

  for (const raw of candidates) {
    const a = canonBase(raw);
    const aNo = canonNoSpaces(a);

    if (map.has(a)) return map.get(a);

    const withSpace = a.replace(/_/g, ' ');
    const withUnd   = a.replace(/\s+/g, '_');
    if (map.has(withSpace)) return map.get(withSpace);
    if (map.has(withUnd))   return map.get(withUnd);

    for (const [ck, v] of map.entries()) { if (canonNoSpaces(ck) === aNo) return v; }
    for (const [ck, v] of map.entries()) {
      if (ck.includes(a) || a.includes(ck) || canonNoSpaces(ck).includes(aNo) || aNo.includes(canonNoSpaces(ck))) {
        return v;
      }
    }
  }
  return undefined;
}

const FILTERABLE_FIELDS = new Set([
  'departamento','ciudad','macrocategoria','macro categoria',
  'categoria','subcategoria','segmento','marca',
]);

/** Ventas / Unidades desde aliases comunes */
function pickVentaFromRow(row) {
  const cand = [
    'total','ventas','venta','valor_total','valor total','valor',
    'monto','importe','total venta','venta total','revenue','neto','subtotal',
    'total_venta','total venta neta'
  ];
  return toNumberLoose(getField(row, cand));
}
function pickCityCanon(row) {
  const val = getField(row, ['ciudad','municipio','mpio','municipio nombre','ciudad municipio','poblacion','localidad']);
  return canonCity(val);
}
function pickDeptCanon(row) {
  const val = getField(row, ['departamento','dpto','depto','dep','departamento nombre']);
  return canonDept(val);
}

/* ====== Fecha → clave mensual YYYY-MM ====== */
const MES_NOMBRE = {
  'ene':1,'enero':1,'feb':2,'febrero':2,'mar':3,'marzo':3,'abr':4,'abril':4,
  'may':5,'mayo':5,'jun':6,'junio':6,'jul':7,'julio':7,'ago':8,'agosto':8,
  'sep':9,'sept':9,'septiembre':9,'set':9,'oct':10,'octubre':10,'nov':11,'noviembre':11,'dic':12,'diciembre':12,
  // inglés
  'jan':1,'january':1,'february':2,'mar_en':3,'march':3,'apr':4,'april':4,
  'may_en':5,'jun_en':6,'june':6,'jul_en':7,'july':7,'aug':8,'august':8,
  'sep_en':9,'sept_en':9,'september':9,'oct_en':10,'october':10,'nov_en':11,'november':11,'dec':12,'december':12,
};
function pad2(n){ return String(n).padStart(2,'0'); }
function yyyymm(d){ return `${d.getFullYear()}-${pad2(d.getMonth()+1)}`; }

function pickPeriodoKey(row) {
  // 1) fecha directa
  const fRaw = getField(row, ['fecha','fecha venta','fecha_venta','date','created at','created_at','dia','día']);
  if (fRaw) {
    // normaliza dd-mm-yyyy → mm/dd/yyyy para Date
    const d1 = new Date(String(fRaw).replace(/(\d{2})-(\d{2})-(\d{4})/, '$2/$1/$3'));
    if (!isNaN(d1)) return yyyymm(d1);
    const s = String(fRaw).trim();
    let m = s.match(/(\d{4})[^\d]?(\d{1,2})/); // yyyy[-/]mm
    if (!m) m = s.match(/(\d{1,2})[^\d](\d{4})/); // mm[-/]yyyy
    if (m) {
      const y  = m[1].length === 4 ? Number(m[1]) : Number(m[2]);
      const mm = m[1].length === 4 ? Number(m[2]) : Number(m[1]);
      if (y && mm) return `${y}-${pad2(mm)}`;
    }
  }
  // 2) año + mes separados
  const yRaw = getField(row, ['ano','año','anio','year','yyyy']);
  let mRaw   = getField(row, ['mes','month','mmm','mm']);
  if (yRaw && mRaw) {
    let mm = toNumberLoose(mRaw);
    if (!mm) {
      const mmTxt = canonBase(mRaw);
      mm = MES_NOMBRE[mmTxt] || MES_NOMBRE[mmTxt.replace(/\s+/g,'')] || 0;
    }
    const y = toNumberLoose(yRaw);
    if (y && mm) return `${y}-${pad2(mm)}`;
  }
  // 3) periodo compacto (2024-07 / 07-2024 / 202407)
  const pRaw = getField(row, ['periodo','periodo mes','periodo_mes','mes anio','mes año','mes_anio']);
  if (pRaw) {
    const s = String(pRaw).trim();
    let m = s.match(/^(\d{4})[-/ ](\d{1,2})$/);      // 2024-07
    if (!m) m = s.match(/^(\d{1,2})[-/ ](\d{4})$/);  // 07-2024
    if (m) {
      const y  = m[1].length === 4 ? Number(m[1]) : Number(m[2]);
      const mm = m[1].length === 4 ? Number(m[2]) : Number(m[1]);
      if (y && mm) return `${y}-${pad2(mm)}`;
    }
    m = s.match(/^(\d{4})(\d{2})$/); // 202407
    if (m) return `${m[1]}-${m[2]}`;
  }
  return null; // si no hay forma de inferir
}

/* ============ Endpoint: GET /ventas/serie ============ */
router.get('/', (req, res) => {
  // Inversión (en MILLONES de COP) → escalar a COP
  const invMetaM   = toNumberLoose(req.query.inv_meta);
  const invGoogleM = toNumberLoose(req.query.inv_google);
  const invTotalCOP = ((invMetaM || 0) + (invGoogleM || 0)) * 1e6;

  // Filtros normalizados (excluye inv_*)
  const filtrosCanon = {};
  for (const [k, v] of Object.entries(req.query || {})) {
    const kCanon = canonBase(k);
    if (!FILTERABLE_FIELDS.has(kCanon)) continue;
    if (v !== undefined && v !== null && String(v) !== '') {
      filtrosCanon[kCanon] = canonBase(v);
    }
  }

  // Regla Bogotá si filtran por departamento
  const deptFilterCanon = filtrosCanon.departamento || null;
  const deptEsBogota = deptFilterCanon
    ? (deptFilterCanon === 'bogota' || deptFilterCanon === 'bogota dc' || deptFilterCanon === 'bogota d c')
    : false;

  const csvPath = path.join(__dirname, '../data/ventas_limpias.csv');
  if (!fs.existsSync(csvPath)) {
    return res.status(500).json({ error: `No se encontró el CSV en ${csvPath}` });
  }

  // Acumulación por mes
  const basePorMes = new Map(); // YYYY-MM -> ventas base

  fs.createReadStream(csvPath)
    .pipe(csv({
      mapHeaders: ({ header }) => canonBase(header),
      skipLines: 0
    }))
    .on('data', (row) => {
      try {
        // Canon ciudad/departamento
        const rowCityCanon = pickCityCanon(row);
        const rowDeptCanon = pickDeptCanon(row);

        // Aplica filtros
        for (const [kCanon, vCanon] of Object.entries(filtrosCanon)) {
          if (kCanon === 'departamento') {
            if (deptEsBogota) {
              const rowDeptIsBogota = (rowDeptCanon === 'bogota');
              const rowDeptIsCundi  = (rowDeptCanon === 'cundinamarca');
              const rowCityIsBogota = isBogotaCityCanon(rowCityCanon);
              if (!(rowCityIsBogota || rowDeptIsBogota || rowDeptIsCundi)) return;
            } else {
              if (rowDeptCanon !== vCanon) return;
            }
          } else if (kCanon === 'ciudad') {
            if (rowCityCanon !== canonCity(vCanon)) return;
          } else {
            const fieldVal = getField(row, [kCanon, kCanon.replace(/\s+/g,'_'), kCanon.replace(/_/g,' ')]);
            const rowValCanon = canonBase(fieldVal);
            if (rowValCanon !== vCanon) return;
          }
        }

        const key = pickPeriodoKey(row);
        if (!key) return; // si no podemos inferir el mes, saltamos la fila

        const venta = pickVentaFromRow(row) || 0;
        basePorMes.set(key, (basePorMes.get(key) || 0) + venta);
      } catch (e) {
        // ignora filas problemáticas sin romper el stream
      }
    })
    .on('end', () => {
      // Distribución de la inversión
      const meses = Array.from(basePorMes.keys()).sort(); // YYYY-MM asc
      const totalBase = Array.from(basePorMes.values()).reduce((a,b)=>a+b, 0);

      const totales = new Map(); // mes -> total final (base + inversión distribuida)
      if (meses.length === 0) {
        // Sin ventas base: si hay inversión, celébrala en el mes actual
        if (invTotalCOP > 0) {
          const hoy = new Date();
          const mesActual = yyyymm(hoy);
          totales.set(mesActual, invTotalCOP);
        }
      } else if (invTotalCOP > 0 && totalBase > 0) {
        for (const m of meses) {
          const base = basePorMes.get(m) || 0;
          const share = (base / totalBase) * invTotalCOP;
          totales.set(m, base + share);
        }
      } else {
        // sin inversión o sin base total (>0), devolver base
        for (const m of meses) totales.set(m, basePorMes.get(m) || 0);
      }

      // Construye respuesta
      const resultado = Array.from(totales.entries())
        .map(([fecha, total]) => ({ fecha, total }))
        .sort((a, b) => a.fecha.localeCompare(b.fecha));

      res.json(resultado);
    })
    .on('error', (err) => {
      console.error('[ventas/serie] error leyendo CSV:', err);
      res.status(500).json({ error: 'Error procesando ventas mensuales' });
    });
});

module.exports = router;
