// backend/index.js
const express = require('express');
const cors = require('cors');
const path = require('path');

const ventasRouter = require('./routes/ventas');
const filtrosRouter = require('./routes/filtros');
const agregadasRouter = require('./routes/ventas_agregadas');
const seriesRouter = require('./routes/ventas_series');
const kpisRouter = require('./routes/kpis');
const exportRouter = require('./routes/export');
const mapaRouter = require('./routes/ventas_mapa'); // NUEVO

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

const staticDir = path.join(__dirname, 'public');

app.use(express.static(staticDir, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.geojson')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
  }
}));

// Rutas API oficiales
app.use('/ventas', ventasRouter);
app.use('/filtros', filtrosRouter);
app.use('/ventas/agregadas', agregadasRouter);
app.use('/ventas/series', seriesRouter);
app.use('/kpis', kpisRouter);
app.use('/export', exportRouter);
app.use('/ventas/mapa', mapaRouter); // NUEVO

// 🧩 Alias para compatibilidad
app.use('/filters', filtrosRouter);         // alias de /filtros
app.use('/timeseries', seriesRouter);       // alias de /ventas/series

// Ruta base
app.get('/', (req, res) => res.sendFile(path.join(staticDir, 'index.html')));

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});

