// backend/routes/kpis.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

const router = express.Router();

/* ========= Utils ========= */
function canonBase(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // sin tildes
    .toLowerCase()
    .replace(/[.,()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
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

/** Campos “filtrables” vía query */
const FILTERABLE_FIELDS = new Set([
  'departamento', 'ciudad',
  'macrocategoria', 'categoria', 'subcategoria',
  'segmento', 'marca',
]);

/** Extrae valores numéricos desde columnas típicas */
function pickVentaFromRow(row) {
  // headers ya vienen canónicos por mapHeaders
  return toNumberLoose(row.total ?? row.valor_total ?? row.valor);
}
function pickUnidadesFromRow(row) {
  return toNumberLoose(row.cantidad ?? row.unidades);
}

router.get('/', (req, res) => {
  let totalVentasBase = 0;
  let totalUnidades = 0;
  const categorias = new Set();

  // Inversión (USD)
  const invMeta   = toNumberLoose(req.query.inv_meta);
  const invGoogle = toNumberLoose(req.query.inv_google);
  const invTotal  = (invMeta || 0) + (invGoogle || 0);

  // Filtros normalizados
  const filtrosCanon = {};
  for (const [k, v] of Object.entries(req.query || {})) {
    const kCanon = canonBase(k);
    if (!FILTERABLE_FIELDS.has(kCanon)) continue;
    if (v !== undefined && v !== null && String(v) !== '') {
      filtrosCanon[kCanon] = canonBase(v);
    }
  }

  // Bandera si departamento filtrado es Bogotá
  const deptFilterCanon = filtrosCanon.departamento || null;
  const deptEsBogota = deptFilterCanon
    ? (deptFilterCanon === 'bogota' || deptFilterCanon === 'bogota dc' || deptFilterCanon === 'bogota d c')
    : false;

  const csvPath = path.join(__dirname, '../data/ventas_limpias.csv');
  if (!fs.existsSync(csvPath)) {
    return res.status(500).json({ error: `No se encontró el CSV en ${csvPath}` });
  }

  fs.createReadStream(csvPath)
    .pipe(csv({
      // CLAVE: normalizamos headers → luego row.ciudad / row.departamento existen siempre en minúsculas
      mapHeaders: ({ header }) => canonBase(header),
      skipLines: 0
    }))
    .on('data', (row) => {
      // Canon para ciudad/departamento de la fila
      const rowCityCanon = canonCity(row.ciudad);
      const rowDeptCanon = canonDept(row.departamento);

      // Aplica filtros: comparamos canónicos
      for (const [kCanon, vCanon] of Object.entries(filtrosCanon)) {
        if (kCanon === 'departamento') {
          // Regla especial BOGOTÁ:
          // - Si filtro = Bogotá, aceptamos filas donde:
          //     * ciudad sea Bogotá, o
          //     * departamento sea "bogota" o "cundinamarca"
          if (deptEsBogota) {
            const rowDeptIsBogota = (rowDeptCanon === 'bogota');
            const rowDeptIsCundi  = (rowDeptCanon === 'cundinamarca');
            const rowCityIsBogota = isBogotaCityCanon(rowCityCanon);
            if (!(rowCityIsBogota || rowDeptIsBogota || rowDeptIsCundi)) {
              return; // descarta fila
            }
          } else {
            if (rowDeptCanon !== vCanon) return;
          }
        } else if (kCanon === 'ciudad') {
          if (rowCityCanon !== canonCity(vCanon)) return;
        } else {
          // otros campos de catálogo
          const rowValCanon = canonBase(row[kCanon]);
          if (rowValCanon !== vCanon) return;
        }
      }

      // Suma métricas
      totalVentasBase += pickVentaFromRow(row);
      totalUnidades   += Math.round(pickUnidadesFromRow(row));

      if (row.categoria != null && row.categoria !== '') categorias.add(row.categoria);
    })
    .on('end', () => {
      // Ajuste por inversión
      const ventasFinales =
        totalVentasBase > 0
          ? totalVentasBase * (1 + invTotal / totalVentasBase)
          : invTotal;

      const ticketFinal =
        totalUnidades > 0 ? (ventasFinales / totalUnidades) : 0;

      res.json({
        total_ventas: ventasFinales,
        unidades_vendidas: totalUnidades,
        ticket_promedio: ticketFinal,
        categorias_activas: categorias.size,
        // debug útiles
        base_total_ventas: totalVentasBase,
        inversion_total: invTotal
      });
    })
    .on('error', (err) => {
      console.error('[kpis] error leyendo CSV:', err);
      res.status(500).json({ error: 'Error procesando KPIs' });
    });
});

module.exports = router;


