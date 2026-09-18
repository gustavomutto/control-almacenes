const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');

const router = express.Router();

function hoyISO() {
  return new Date().toISOString().slice(0, 10);
}

// Resumen del día, consolidado por almacén.
router.get('/', async (req, res) => {
  const fecha = req.query.fecha || hoyISO();

  const [almacenes, ventasPorAlmacen, gastosPorAlmacen] = await Promise.all([
    pool.query('SELECT * FROM almacenes WHERE activo = true ORDER BY nombre'),
    pool.query(
      `SELECT almacen_id, COALESCE(SUM(total_venta),0) AS venta, COALESCE(SUM(total_costo),0) AS costo, COALESCE(SUM(margen),0) AS margen
       FROM ventas WHERE fecha = $1 GROUP BY almacen_id`,
      [fecha]
    ),
    pool.query(
      `SELECT almacen_id, COALESCE(SUM(valor),0) AS total FROM gastos WHERE fecha = $1 GROUP BY almacen_id`,
      [fecha]
    ),
  ]);

  const ventasMap = Object.fromEntries(ventasPorAlmacen.rows.map((r) => [r.almacen_id, r]));
  const gastosMap = Object.fromEntries(gastosPorAlmacen.rows.map((r) => [r.almacen_id, r.total]));

  const filas = almacenes.rows.map((a) => ({
    almacen: a,
    venta: Number(ventasMap[a.id]?.venta || 0),
    costo: Number(ventasMap[a.id]?.costo || 0),
    margen: Number(ventasMap[a.id]?.margen || 0),
    gastos: Number(gastosMap[a.id] || 0),
  }));

  const totales = filas.reduce(
    (acc, f) => ({
      venta: acc.venta + f.venta,
      costo: acc.costo + f.costo,
      margen: acc.margen + f.margen,
      gastos: acc.gastos + f.gastos,
    }),
    { venta: 0, costo: 0, margen: 0, gastos: 0 }
  );

  res.render('jefa/panel', { filas, totales, fecha, hoy: hoyISO() });
});

// Reporte mensual: ganancia real total (sin descontar gastos) + gastos totales, por almacén y consolidado.
router.get('/reporte', async (req, res) => {
  const mes = req.query.mes || hoyISO().slice(0, 7);
  const almacenFiltro = req.query.almacen || 'todos';

  const almacenes = await pool.query('SELECT * FROM almacenes ORDER BY nombre');

  const condAlmacen = almacenFiltro !== 'todos' ? 'AND almacen_id = $2' : '';
  const paramsVentas = almacenFiltro !== 'todos' ? [mes, almacenFiltro] : [mes];

  const [porAlmacen, porDia, gastosPorAlmacen] = await Promise.all([
    pool.query(
      `SELECT almacen_id, COALESCE(SUM(total_venta),0) AS venta, COALESCE(SUM(total_costo),0) AS costo, COALESCE(SUM(margen),0) AS margen
       FROM ventas WHERE to_char(fecha,'YYYY-MM') = $1 ${condAlmacen}
       GROUP BY almacen_id`,
      paramsVentas
    ),
    pool.query(
      `SELECT fecha, COALESCE(SUM(total_venta),0) AS venta, COALESCE(SUM(total_costo),0) AS costo, COALESCE(SUM(margen),0) AS margen
       FROM ventas WHERE to_char(fecha,'YYYY-MM') = $1 ${condAlmacen}
       GROUP BY fecha ORDER BY fecha`,
      paramsVentas
    ),
    pool.query(
      `SELECT almacen_id, COALESCE(SUM(valor),0) AS total
       FROM gastos WHERE to_char(fecha,'YYYY-MM') = $1 ${condAlmacen}
       GROUP BY almacen_id`,
      paramsVentas
    ),
  ]);

  const ventasMap = Object.fromEntries(porAlmacen.rows.map((r) => [r.almacen_id, r]));
  const gastosMap = Object.fromEntries(gastosPorAlmacen.rows.map((r) => [r.almacen_id, r.total]));

  const filasAlmacen = almacenes.rows
    .filter((a) => almacenFiltro === 'todos' || String(a.id) === String(almacenFiltro))
    .map((a) => ({
      almacen: a,
      venta: Number(ventasMap[a.id]?.venta || 0),
      costo: Number(ventasMap[a.id]?.costo || 0),
      margen: Number(ventasMap[a.id]?.margen || 0),
      gastos: Number(gastosMap[a.id] || 0),
    }));

  const totalGeneral = filasAlmacen.reduce(
    (acc, f) => ({
      venta: acc.venta + f.venta,
      costo: acc.costo + f.costo,
      margen: acc.margen + f.margen,
      gastos: acc.gastos + f.gastos,
    }),
    { venta: 0, costo: 0, margen: 0, gastos: 0 }
  );

  res.render('jefa/reporte', {
    mes,
    almacenes: almacenes.rows,
    almacenFiltro,
    filasAlmacen,
    porDia: porDia.rows,
    totalGeneral,
  });
});

// --- Administración (solo rol admin) ---

router.get('/admin', async (req, res) => {
  if (req.session.usuario.rol !== 'admin') return res.status(403).render('403');
  const [almacenes, usuarios] = await Promise.all([
    pool.query('SELECT * FROM almacenes ORDER BY nombre'),
    pool.query(
      `SELECT u.*, a.nombre AS almacen_nombre FROM usuarios u
       LEFT JOIN almacenes a ON a.id = u.almacen_id ORDER BY u.rol, u.usuario`
    ),
  ]);
  res.render('jefa/admin', {
    almacenes: almacenes.rows,
    usuarios: usuarios.rows,
    mensaje: req.query.ok || null,
    tempPassword: req.query.pass || null,
    tempUsuario: req.query.u || null,
  });
});

router.post('/admin/almacenes', async (req, res) => {
  if (req.session.usuario.rol !== 'admin') return res.status(403).render('403');
  const { nombre } = req.body;
  if (!nombre || !nombre.trim()) {
    return res.redirect('/jefa/admin');
  }
  await pool.query('INSERT INTO almacenes (nombre) VALUES ($1) ON CONFLICT (nombre) DO NOTHING', [nombre.trim()]);
  res.redirect('/jefa/admin?ok=' + encodeURIComponent('Almacén creado.'));
});

function generarPassword() {
  const letras = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 10; i++) out += letras[Math.floor(Math.random() * letras.length)];
  return out;
}

router.post('/admin/usuarios', async (req, res) => {
  if (req.session.usuario.rol !== 'admin') return res.status(403).render('403');
  const { nombre, usuario, rol, almacen_id } = req.body;

  if (!nombre || !usuario || !rol) {
    return res.redirect('/jefa/admin');
  }
  if (rol === 'almacen' && !almacen_id) {
    return res.redirect('/jefa/admin?ok=' + encodeURIComponent('Elige un almacén para este usuario.'));
  }

  const pass = generarPassword();
  const hash = await bcrypt.hash(pass, 10);
  const usuarioLimpio = usuario.trim().toLowerCase();

  await pool.query(
    `INSERT INTO usuarios (almacen_id, usuario, password_hash, nombre, rol)
     VALUES ($1,$2,$3,$4,$5)`,
    [rol === 'almacen' ? almacen_id : null, usuarioLimpio, hash, nombre.trim(), rol]
  );

  res.redirect(
    `/jefa/admin?ok=${encodeURIComponent('Usuario creado.')}&u=${encodeURIComponent(usuarioLimpio)}&pass=${encodeURIComponent(pass)}`
  );
});

router.post('/admin/usuarios/:id/desactivar', async (req, res) => {
  if (req.session.usuario.rol !== 'admin') return res.status(403).render('403');
  await pool.query('UPDATE usuarios SET activo = false WHERE id = $1', [req.params.id]);
  res.redirect('/jefa/admin?ok=' + encodeURIComponent('Usuario desactivado.'));
});

module.exports = router;
