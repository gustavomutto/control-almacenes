require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);

const pool = require('./db/pool');
const authRoutes = require('./routes/auth');
const almacenRoutes = require('./routes/almacen');
const jefaRoutes = require('./routes/jefa');
const { requireLogin } = require('./middleware/auth');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.set('trust proxy', 1); // Railway está detrás de un proxy

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
    },
  })
);

const nf = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });
const nfCant = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 });
app.locals.fmt = (v) => `$ ${nf.format(Number(v) || 0)}`;
app.locals.fmtCant = (v) => nfCant.format(Number(v) || 0);

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
