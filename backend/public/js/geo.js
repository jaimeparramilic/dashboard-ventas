// backend/public/js/geo.js
import { lsGetJSON, lsSetJSON, pick, cachedFetch } from "./utils.js";
import { canonDeptStrict, canonCityStrict } from './overrides-derived.esm.js';

/* =================== Rutas GeoJSON (GCS) =================== */
// AJUSTA el BUCKET si cambió
const GCS_BUCKET = "ventas-geo-bubbly-vine-471620-h1";
const URL_DEPTOS   = `https://storage.googleapis.com/${GCS_BUCKET}/departamentos.geojson`;
const URL_CIUDADES = `https://storage.googleapis.com/${GCS_BUCKET}/ciudades.geojson`;

/* =================== Estado exportado =================== */
export let geoDeptos = null;   // GeoJSON ADM1 (departamentos)
export let geoCiudades = null; // GeoJSON ADM2 (municipios/ciudades)

export let DETECTED_DEPT_PROP = null;
export let DETECTED_CITY_PROP = null;

/* =================== Canon & helpers básicos (export) =================== */
export function canonBase(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[.,()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
export function softClean(s) {
  return String(s ?? "")
    .replace(/\b(d\.?t\.?c\.?h\.?)\b/gi, " d t c h ")
    .replace(/\b(d\.?c\.?)\b/gi, " dc ")
    .replace(/[“”'’"]/g, " ")
    .replace(/[–—]/g, "-");
}
export function canonDept(name) {
  return canonBase(name)
    .replace(/^departamento del? /, '')
    .replace(/^dpto del? /, '')
    .replace(/ departamento$/, '')
    .replace(/ depto$/, '');
}
export function canonCity(name) {
  return canonBase(name)
    .replace(/^municipio de /, '')
    .replace(/^ciudad de /, '');
}
export function isBogotaCityCanon(c) {
  return c === 'bogota' || c === 'bogota d c' || c === 'bogota dc';
}

/* =================== Lectura de nombres desde feature =================== */
export function nombreDeptoFromFeature(f) {
  const p = f?.properties || {};
  if (DETECTED_DEPT_PROP && p[DETECTED_DEPT_PROP] != null && p[DETECTED_DEPT_PROP] !== '') {
    return String(p[DETECTED_DEPT_PROP]);
  }
  return pick(p, [
    "shapeName","NAME_1","name_1",
    "NOMBRE_DPT","NOMBRE_DEP","DEPARTAMEN","DPTO_CNMBR",
    "departamento","DEPARTAMENTO","dpto","dpt",
    "NAME","name"
  ]) || "";
}
export function nombreCiudadFromFeature(f) {
  const p = f?.properties || {};
  if (DETECTED_CITY_PROP && p[DETECTED_CITY_PROP] != null && p[DETECTED_CITY_PROP] !== '') {
    return String(p[DETECTED_CITY_PROP]);
  }
  return pick(p, [
    "NAME_2","name_2",
    "NOMBRE_MPIO","MPIO_CNMBR","NOM_MPIO",
    "municipio","MUNICIPIO",
    "ciudad","CIUDAD","NOMBRE_CIU",
    "shapeName","NAME","name"
  ]) || "";
}

/* =================== Detección de props (export) =================== */
export function detectPropNames(geo, level) {
  const feats = geo?.features || [];
  if (!feats.length) return;

  const total = feats.length;
  const MAX_SAMPLE = Math.min(total, 1000);

  const PRIOR_DEPT = [
    "NAME_1","name_1","NOMBRE_DPT","NOMBRE_DEP","DEPARTAMEN","DPTO_CNMBR",
    "departamento","DEPARTAMENTO","dpto","dpt","shapeName","NAME","name"
  ];
  const PRIOR_CITY = [
    "NAME_2","name_2","NOMBRE_MPIO","MPIO_CNMBR","NOM_MPIO",
    "municipio","MUNICIPIO","ciudad","CIUDAD","NOMBRE_CIU",
    "shapeName","NAME","name"
  ];

  const disallowRe = /(objectid|shapeid|^id$|_id$|^gid$|code|cod|c_digo)/i;
  const nameHintRe = (level === 'departamento')
    ? /(depart|dpto|name_1|adm1|prov|estado|shape|name)/i
    : /(ciud|mpio|municip|name_2|adm2|local|town|city|shape|name)/i;

  const stats = new Map();
  const alphaRatio = (s) => {
    const t = String(s||'');
    const alpha = (t.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g)||[]).length;
    return alpha / Math.max(1, t.length);
  };

  for (let i = 0; i < MAX_SAMPLE; i++) {
    const p = feats[i]?.properties || {};
    for (const [k, v] of Object.entries(p)) {
      if (v == null) continue;
      const s = String(v).trim();
      if (!s) continue;
      let st = stats.get(k);
      if (!st) st = { present: 0, uniq: new Set(), alpha: 0 };
      st.present++;
      st.uniq.add(canonBase(s));
      st.alpha += alphaRatio(s);
      stats.set(k, st);
    }
  }

  const scoreKey = (k) => {
    const st = stats.get(k); if (!st) return -1;
    const presentRatio = st.present / MAX_SAMPLE;
    const uniqRatio = Math.min(1, st.uniq.size / MAX_SAMPLE);
    const avgAlpha = st.alpha / Math.max(1, st.present);

    if (presentRatio < 0.5) return -1;
    if (avgAlpha < 0.35) return -1;

    const isPriority = (level === 'departamento' ? PRIOR_DEPT.includes(k) : PRIOR_CITY.includes(k)) ? 1 : 0;
    const hint = nameHintRe.test(k) ? 1 : 0;
    const disallow = disallowRe.test(k) ? 1 : 0;

    let score = 0;
    score += 2.5 * isPriority;
    score += 1.5 * hint;
    score += 2.0 * uniqRatio;
    score += 1.0 * presentRatio;
    score += 0.5 * avgAlpha;
    score -= 2.0 * disallow;
    return score;
  };

  let bestKey = null, bestScore = -1;
  for (const k of stats.keys()) {
    const sc = scoreKey(k);
    if (sc > bestScore) { bestScore = sc; bestKey = k; }
  }

  // Anti-ambigüedad: evita usar props típicas de depto como ciudad
  try {
    const props0 = Object.keys((geo?.features?.[0]?.properties) || {});
    const looksLikeDept = (k) => /shapeName|NAME_1|name_1|NOMBRE_DPT|NOMBRE_DEP|DEPARTAMEN|DPTO_CNMBR|DEPARTAMENTO|dpto|dpt/i.test(k);

    if (level === 'ciudad') {
      if (!bestKey) {
        if (props0.includes('NAME_2')) bestKey = 'NAME_2';
        else if (props0.includes('name_2')) bestKey = 'name_2';
        else if (props0.includes('NOMBRE_MPIO')) bestKey = 'NOMBRE_MPIO';
      }
      if (!bestKey || (DETECTED_DEPT_PROP && bestKey === DETECTED_DEPT_PROP) || looksLikeDept(bestKey)) {
        if (props0.includes('NAME_2')) bestKey = 'NAME_2';
        else if (props0.includes('name_2')) bestKey = 'name_2';
        else if (props0.includes('NOMBRE_MPIO')) bestKey = 'NOMBRE_MPIO';
        console.warn('[geo] city prop ajustada (evitamos dept):', bestKey);
      }
    }
  } catch {}

  if (level === 'departamento') DETECTED_DEPT_PROP = bestKey;
  else DETECTED_CITY_PROP = bestKey;

  console.log(`[geo] clave detectada para ${level}:`, bestKey, 'score=', (bestScore ?? 0).toFixed?.(3));
}

/* =================== Forzador de prop de ciudad (export) =================== */
export function forceCityPropIfWrong(geo) {
  try {
    const feats = geo?.features || [];
    if (!feats.length) return;

    const props0 = Object.keys(feats[0]?.properties || {});
    const CITY_CANDIDATES = [
      "NAME_2","name_2","NOMBRE_MPIO","MPIO_CNMBR","NOM_MPIO",
      "municipio","MUNICIPIO","ciudad","CIUDAD","NOMBRE_CIU"
    ];

    const looksLikeDept = (k) => /shapeName|NAME_1|name_1|NOMBRE_DPT|NOMBRE_DEP|DEPARTAMEN|DPTO_CNMBR|DEPARTAMENTO|dpto|dpt/i.test(k);

    const needFix =
      !DETECTED_CITY_PROP ||
      DETECTED_CITY_PROP === DETECTED_DEPT_PROP ||
      looksLikeDept(DETECTED_CITY_PROP);

    if (!needFix) return;

    // Busca primero en el primer feature, luego en un probe de 50
    let found = CITY_CANDIDATES.find(c => props0.includes(c));
    if (!found) {
      const probe = Math.min(feats.length, 50);
      const allProps = new Set();
      for (let i = 0; i < probe; i++) {
        for (const k of Object.keys(feats[i].properties || {})) allProps.add(k);
      }
      found = CITY_CANDIDATES.find(c => allProps.has(c));
    }

    if (found) {
      console.warn(`[geo] city prop corregida: ${DETECTED_CITY_PROP} -> ${found}`);
      DETECTED_CITY_PROP = found;
    } else {
      console.error('[geo] No se encontró ninguna propiedad típica de ciudad (ADM2). Revisa tu GeoJSON de ciudades.');
    }
  } catch (e) {
    console.warn('forceCityPropIfWrong error:', e);
  }
}

/* =================== Augment estricto (export) =================== */
export function augmentGeo(geo, level) {
  try {
    const feats = geo?.features || [];
    for (const f of feats) {
      const p = f.properties || (f.properties = {});
      const dRaw = nombreDeptoFromFeature(f);
      const cRaw = nombreCiudadFromFeature(f);

      const dCanon = canonDeptStrict(canonBase, softClean, dRaw);
      const recCity = canonCityStrict(canonBase, softClean, cRaw, dRaw);

      p.__canon_dpto = dCanon;
      p.__canon_city = recCity?.ciudad_canon || "";
      p.__canon_dpto_for_city = recCity?.departamento_para_ciudad || dCanon;
    }
  } catch (e) {
    console.warn('augmentGeo strict error:', e);
  }
}

/* ======= Mejora de cobertura ADM2 vs backend (export) ======= */
export function ensureBestCityPropForCoverage(geoCities, agregados) {
  try {
    const feats = geoCities?.features || [];
    if (!feats.length || !Array.isArray(agregados) || !agregados.length) return;

    const backendKeys = new Set();
    for (const row of agregados) {
      const dCanon = canonDept(row.departamento || row.dpto || row.dep || "");
      const cCanon = canonCity(row.ciudad || row.municipio || row.mpio || "");
      const dForCity = isBogotaCityCanon(cCanon) ? 'bogota dc' : dCanon;
      if (cCanon) backendKeys.add(`${cCanon}__${dForCity}`);
    }
    if (backendKeys.size === 0) return;

    const sampleProps = Object.keys(feats[0]?.properties || {});
    const disallowRe = /(objectid|shapeid|^id$|_id$|^gid$|code|cod|c_digo)/i;
    const candidates = new Set([
      ...sampleProps,
      "NAME_2","name_2","NOMBRE_MPIO","MPIO_CNMBR","NOM_MPIO",
      "municipio","MUNICIPIO","ciudad","CIUDAD","NOMBRE_CIU","shapeName","NAME","name"
    ]);

    const scoreForProp = (prop) => {
      if (!prop || disallowRe.test(prop)) return -1;
      let present = 0, matches = 0, alphaSum = 0;
      const N = Math.min(feats.length, 3000);
      for (let i = 0; i < N; i++) {
        const p = feats[i]?.properties || {};
        const v = p[prop];
        if (v == null) continue;
        const s = String(v).trim();
        if (!s) continue;
        present++;
        const cCanon = canonCity(s);
        const dCanon = canonDept(nombreDeptoFromFeature(feats[i]));
        const dForCity = isBogotaCityCanon(cCanon) ? 'bogota dc' : dCanon;
        const key = cCanon ? `${cCanon}__${dForCity}` : '';
        if (key && backendKeys.has(key)) matches++;
        const alpha = (s.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g)||[]).length;
        alphaSum += alpha / Math.max(1, s.length);
      }
      if (present === 0) return -1;
      const presentRatio = present / Math.min(N, feats.length);
      const avgAlpha = alphaSum / present;
      if (presentRatio < 0.5 || avgAlpha < 0.35) return -1;
      return matches + 0.3 * presentRatio + 0.2 * avgAlpha;
    };

    let best = DETECTED_CITY_PROP || null;
    let bestScore = best ? scoreForProp(best) : -1;

    for (const prop of candidates) {
      const sc = scoreForProp(prop);
      if (sc > bestScore) { bestScore = sc; best = prop; }
    }

    if (best && best !== DETECTED_CITY_PROP) {
      console.log(`[geo] city prop mejor por cobertura: ${DETECTED_CITY_PROP} -> ${best} (score=${bestScore.toFixed(2)})`);
      DETECTED_CITY_PROP = best;
    }
  } catch (e) {
    console.warn('ensureBestCityPropForCoverage error:', e);
  }
}

/* =================== Carga de GeoJSON (export) =================== */
export async function cargarGeoJSON(nivelWanted = 'departamento') {
  const needDept = (nivelWanted === 'departamento' && !geoDeptos);
  const needCity = (nivelWanted === 'ciudad'        && !geoCiudades);
  if (!needDept && !needCity) return;

  async function fetchAndMaybeTopo(kind, url) {
    const lsKey = `geo:${kind}`;
    const fromLS = lsGetJSON(lsKey);
    if (fromLS) return fromLS;

    const res = await cachedFetch(url, {}, 24 * 60 * 60 * 1000);
    const text = await res.text();

    let data = JSON.parse(text);
    if (data && data.type === 'Topology' && window.topojson && typeof window.topojson.feature === 'function') {
      const objName = Object.keys(data.objects)[0];
      data = window.topojson.feature(data, data.objects[objName]);
    }
    lsSetJSON(lsKey, data);
    return data;
  }

  if (needDept) {
    geoDeptos = await fetchAndMaybeTopo('dept', URL_DEPTOS);
    detectPropNames(geoDeptos, 'departamento');
    augmentGeo(geoDeptos, 'departamento');
  }

  if (needCity) {
    geoCiudades = await fetchAndMaybeTopo('city', URL_CIUDADES);
    detectPropNames(geoCiudades, 'ciudad');
    // 🔧 Corregimos si el detector eligió una prop de depto (p.ej. shapeName)
    forceCityPropIfWrong(geoCiudades);
    // Re-augmenta con la prop correcta para __canon_* válidos
    augmentGeo(geoCiudades, 'ciudad');
  }
}
