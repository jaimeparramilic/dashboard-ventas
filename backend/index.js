// backend/index.js
const express = require('express');
const cors = require('cors');
const path = require('path');
const compression = require('compression');

// Routers
const ventasRouter   = require('./routes/ventas');
const filtrosRouter  = require('./routes/filtros');
const agregadasRouter= require('./routes/ventas_agregadas');
const seriesRouter   = require('./routes/ventas_series'); // <-- series
const kpisRouter     = require('./routes/kpis');
const exportRouter   = require('./routes/export');
const mapaRouter     = require('./routes/ventas_mapa');

// Loader compartido
const { loadOnce } = require('./data/loader');

const app  = express();
const PORT = Number(process.env.PORT || 8080);
const HOST = '0.0.0.0'; // <-- importante en contenedor

app.disable('x-powered-by');
app.use(cors());
app.use(express.json());
app.use(compression());

app.locals.loadData = loadOnce;

// Static
const staticDir = path.join(__dirname, 'public');
app.use(express.static(staticDir, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.geojson')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
  }
}));

// API
app.use('/ventas', ventasRouter);
app.use('/filtros', filtrosRouter);
app.use('/ventas/agregadas', agregadasRouter);
app.use('/ventas/series', seriesRouter);
app.use('/kpis', kpisRouter);
app.use('/export', exportRouter);
app.use('/ventas/mapa', mapaRouter);

// Aliases
app.use('/filters', filtrosRouter);
app.use('/timeseries', seriesRouter);
app.use('/ventas/serie', seriesRouter);  // <-- alias para el front

// Health (para probes)
app.get('/health', (_req, res) => res.status(200).send('ok'));
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// Home SPA
app.get('/', (_req, res) => res.sendFile(path.join(staticDir, 'index.html')));

// Start
app.listen(PORT, HOST, () => {
  console.log(`[server] listening on http://${HOST}:${PORT}`);
});

// Logs por si algo crashea antes de escuchar
process.on('unhandledRejection', (e)=>console.error('unhandledRejection', e));
process.on('uncaughtException',  (e)=>console.error('uncaughtException', e));
