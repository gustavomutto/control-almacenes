require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);

const pool = require('./db/pool');
const authRoutes = require('./routes/auth');
const almacenRoutes = require('./routes/almacen');
const jefaRoutes = require('./routes/jefa');
const { requireLogin } = require('./middleware/auth');

const app = express();

app.disable('x-powered-by');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1); // Railway está detrás de un proxy

// Comprime las páginas antes de enviarlas: menos datos por la red.
app.use(compression());
app.use(express.urlencoded({ extended: true }));

// "Sello" de esta versión del programa. Va pegado a las direcciones del CSS y del JS
// (estilo.css?v=SELLO) para que el navegador los guarde mucho tiempo sin volver a
// pedirlos, y al mismo tiempo reciba los nuevos apenas se publique una versión.
const SELLO =
  process.env.RAILWAY_DEPLOYMENT_ID ||
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  crypto.randomBytes(6).toString('hex');
app.locals.v = SELLO.slice(0, 12);

app.use(
  express.static(path.join(__dirname, '..', 'public'), {
    maxAge: '30d',
    etag: true,
    lastModified: true,
  })
);

app.use(
  session({
    store: new pgSession({ pool, tableName: 'session', createTableIfMissing: true }),
    name: 'almacenes.sid',
    secret: process.env.SESSION_SECRET || 'cambia-esto-en-produccion',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 días
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
    },
  })
);

const nf = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });
const nfCant = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 });
app.locals.fmt = (v) => `$ ${nf.format(Number(v) || 0)}`;
app.locals.fmtCant = (v) => nfCant.format(Number(v) || 0);

// Las columnas DATE llegan como Date a medianoche local; esto las imprime como aaaa-mm-dd
// sin pasar por UTC, que es lo que adelantaba o atrasaba el día en los listados.
app.locals.fechaISO = (d) => {
  if (!d) return '';
  if (typeof d === 'string') return d.slice(0, 10);
  const dos = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
};

app.use((req, res, next) => {
  res.locals.usuario = req.session.usuario || null;
  next();
});

app.use('/', authRoutes);
app.use('/almacen', requireLogin(['almacen']), almacenRoutes);
app.use('/jefa', requireLogin(['jefa', 'admin']), jefaRoutes);

app.get('/', (req, res) => {
  if (!req.session.usuario) return res.redirect('/login');
  if (req.session.usuario.rol === 'almacen') return res.redirect('/almacen');
  return res.redirect('/jefa');
});

app.use((req, res) => {
  res.status(404).render('404');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});
