// backend/index.js
const express = require('express');
const cors = require('cors');
const path = require('path');
const compression = require('compression');

// Routers
const ventasRouter = require('./routes/ventas');
const filtrosRouter = require('./routes/filtros');
const agregadasRouter = require('./routes/ventas_agregadas');
const seriesRouter = require('./routes/ventas_series');
const kpisRouter = require('./routes/kpis');
const exportRouter = require('./routes/export');
const mapaRouter = require('./routes/ventas_mapa');

// Loader compartido (cachea el CSV en memoria)
const { loadOnce } = require('./data/loader');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

app.use(compression());

// expone el loader a todos los routers vía app.locals
app.locals.loadData = loadOnce;

// static del frontend
const staticDir = path.join(__dirname, 'public');
app.use(express.static(staticDir, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.geojson')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
  }
}));

// Rutas API
app.use('/ventas', ventasRouter);
app.use('/filtros', filtrosRouter);
app.use('/ventas/agregadas', agregadasRouter);
app.use('/ventas/series', seriesRouter);
app.use('/kpis', kpisRouter);
app.use('/export', exportRouter);
app.use('/ventas/mapa', mapaRouter);

// Alias
app.use('/filters', filtrosRouter);
app.use('/timeseries', seriesRouter);

// Health (útil para warm-up y checks)
app.get('/health', (_req, res) => res.status(200).send('ok'));

// Home: sirve el index del frontend
app.get('/', (_req, res) => res.sendFile(path.join(staticDir, 'index.html')));

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
