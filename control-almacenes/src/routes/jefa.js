const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');

const router = express.Router();

function hoyISO() {
  return new Date().toISOString().slice(0, 10);
}

function agruparPorRegion(almacenes, filasPorAlmacen) {
  const porId = Object.fromEntries(filasPorAlmacen.map((f) => [f.almacen.id, f]));
  const regiones = [];
  const sinRegion = [];

  for (const a of almacenes) {
    const fila = porId[a.id];
    if (!fila) continue;
    if (a.region_id) {
      let grupo = regiones.find((r) => r.id === a.region_id);
      if (!grupo) {
        grupo = { id: a.region_id, nombre: a.region_nombre, filas: [] };
        regiones.push(grupo);
      }
      grupo.filas.push(fila);
    } else {
      sinRegion.push(fila);
    }
  }
  return { regiones, sinRegion };
}

// Resumen del día, consolidado por almacén y agrupado por región.
router.get('/', async (req, res) => {
  const fecha = req.query.fecha || hoyISO();

  const [almacenes, ventasPorAlmacen, gastosPorAlmacen, unidadesHoy] = await Promise.all([
    pool.query(
      `SELECT a.*, r.nombre AS region_nombre FROM almacenes a
       LEFT JOIN regiones r ON r.id = a.region_id
       WHERE a.activo = true ORDER BY r.nombre NULLS LAST, a.nombre`
    ),
    pool.query(
      `SELECT almacen_id, COALESCE(SUM(total_venta),0) AS venta, COALESCE(SUM(total_costo),0) AS costo, COALESCE(SUM(margen),0) AS margen
       FROM ventas WHERE fecha = $1 GROUP BY almacen_id`,
      [fecha]
    ),
    pool.query(
      `SELECT almacen_id, COALESCE(SUM(valor),0) AS total FROM gastos WHERE fecha = $1 GROUP BY almacen_id`,
      [fecha]
    ),
    pool.query(
      `SELECT v.almacen_id, a.nombre AS almacen_nombre, COALESCE(v.descripcion, m.nombre) AS material,
              SUM(v.cantidad) AS cantidad, SUM(v.total_venta) AS venta
       FROM ventas v
       JOIN almacenes a ON a.id = v.almacen_id
       LEFT JOIN materiales m ON m.id = v.material_id
       WHERE v.fecha = $1
       GROUP BY v.almacen_id, a.nombre, COALESCE(v.descripcion, m.nombre)
       ORDER BY a.nombre, cantidad DESC`,
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

  const totalUnidadesHoy = unidadesHoy.rows.reduce((acc, r) => acc + Number(r.cantidad), 0);

  const { regiones, sinRegion } = agruparPorRegion(almacenes.rows, filas);

  res.render('jefa/panel', {
    regiones,
    sinRegion,
    totales,
    fecha,
    hoy: hoyISO(),
    unidadesHoy: unidadesHoy.rows,
    totalUnidadesHoy,
  });
});

// Reporte mensual: ganancia real total (sin descontar gastos) + gastos totales, por almacén, región y consolidado.
router.get('/reporte', async (req, res) => {
  const mes = req.query.mes || hoyISO().slice(0, 7);
  const almacenFiltro = req.query.almacen || 'todos';
  const regionFiltro = req.query.region || 'todas';

  const [almacenes, regiones] = await Promise.all([
    pool.query(
      `SELECT a.*, r.nombre AS region_nombre FROM almacenes a
       LEFT JOIN regiones r ON r.id = a.region_id
       ORDER BY r.nombre NULLS LAST, a.nombre`
    ),
    pool.query('SELECT * FROM regiones WHERE activo = true ORDER BY nombre'),
  ]);

  let almacenesFiltrados = almacenes.rows;
  if (almacenFiltro !== 'todos') {
    almacenesFiltrados = almacenesFiltrados.filter((a) => String(a.id) === String(almacenFiltro));
  } else if (regionFiltro !== 'todas') {
    almacenesFiltrados = almacenesFiltrados.filter((a) => String(a.region_id) === String(regionFiltro));
  }
  const idsFiltrados = almacenesFiltrados.map((a) => a.id);

  const condAlmacen = idsFiltrados.length > 0 ? 'AND almacen_id = ANY($2::int[])' : '';
  const paramsVentas = idsFiltrados.length > 0 ? [mes, idsFiltrados] : [mes];

  const [porAlmacen, porDia, gastosPorAlmacen, unidadesPorAlmacen] = await Promise.all([
    pool.query(
      `SELECT almacen_id, COALESCE(SUM(total_venta),0) AS venta, COALESCE(SUM(total_costo),0) AS costo,
              COALESCE(SUM(margen),0) AS margen, COALESCE(SUM(cantidad),0) AS unidades
       FROM ventas WHERE to_char(fecha,'YYYY-MM') = $1 ${condAlmacen}
       GROUP BY almacen_id`,
      paramsVentas
    ),
    pool.query(
      `SELECT fecha, COALESCE(SUM(total_venta),0) AS venta, COALESCE(SUM(total_costo),0) AS costo,
              COALESCE(SUM(margen),0) AS margen, COALESCE(SUM(cantidad),0) AS unidades
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
    pool.query(
      `SELECT v.almacen_id, COALESCE(v.descripcion, m.nombre) AS material, SUM(v.cantidad) AS cantidad
       FROM ventas v LEFT JOIN materiales m ON m.id = v.material_id
       WHERE to_char(v.fecha,'YYYY-MM') = $1 ${condAlmacen.replace('almacen_id', 'v.almacen_id')}
       GROUP BY v.almacen_id, COALESCE(v.descripcion, m.nombre)
       ORDER BY cantidad DESC`,
      paramsVentas
    ),
  ]);

  const ventasMap = Object.fromEntries(porAlmacen.rows.map((r) => [r.almacen_id, r]));
  const gastosMap = Object.fromEntries(gastosPorAlmacen.rows.map((r) => [r.almacen_id, r.total]));

  const filasAlmacen = almacenesFiltrados.map((a) => ({
    almacen: a,
    venta: Number(ventasMap[a.id]?.venta || 0),
    costo: Number(ventasMap[a.id]?.costo || 0),
    margen: Number(ventasMap[a.id]?.margen || 0),
    gastos: Number(gastosMap[a.id] || 0),
    unidades: Number(ventasMap[a.id]?.unidades || 0),
  }));

  const totalGeneral = filasAlmacen.reduce(
    (acc, f) => ({
      venta: acc.venta + f.venta,
      costo: acc.costo + f.costo,
      margen: acc.margen + f.margen,
      gastos: acc.gastos + f.gastos,
      unidades: acc.unidades + f.unidades,
    }),
    { venta: 0, costo: 0, margen: 0, gastos: 0, unidades: 0 }
  );

  const unidadesPorMaterial = new Map();
  for (const r of unidadesPorAlmacen.rows) {
    const actual = unidadesPorMaterial.get(r.material) || 0;
    unidadesPorMaterial.set(r.material, actual + Number(r.cantidad));
  }
  const unidadesMaterial = [...unidadesPorMaterial.entries()]
    .map(([material, cantidad]) => ({ material, cantidad }))
    .sort((a, b) => b.cantidad - a.cantidad);

  res.render('jefa/reporte', {
    mes,
    almacenes: almacenes.rows,
    regiones: regiones.rows,
    almacenFiltro,
    regionFiltro,
    filasAlmacen,
    porDia: porDia.rows,
    totalGeneral,
    unidadesMaterial,
  });
});

// Informe de gastos: detalle de cada gasto, filtrable por mes / región / almacén,
// con subtotales por almacén, por región y total general.
router.get('/gastos', async (req, res) => {
  const mes = req.query.mes || hoyISO().slice(0, 7);
  const almacenFiltro = req.query.almacen || 'todos';
  const regionFiltro = req.query.region || 'todas';

  const [almacenes, regiones] = await Promise.all([
    pool.query(
      `SELECT a.*, r.nombre AS region_nombre FROM almacenes a
       LEFT JOIN regiones r ON r.id = a.region_id
       ORDER BY r.nombre NULLS LAST, a.nombre`
    ),
    pool.query('SELECT * FROM regiones WHERE activo = true ORDER BY nombre'),
  ]);

  let almacenesFiltrados = almacenes.rows;
  if (almacenFiltro !== 'todos') {
    almacenesFiltrados = almacenesFiltrados.filter((a) => String(a.id) === String(almacenFiltro));
  } else if (regionFiltro !== 'todas') {
    almacenesFiltrados = almacenesFiltrados.filter((a) => String(a.region_id) === String(regionFiltro));
  }
  const idsFiltrados = almacenesFiltrados.map((a) => a.id);
  const condAlmacen = idsFiltrados.length > 0 ? 'AND g.almacen_id = ANY($2::int[])' : '';
  const params = idsFiltrados.length > 0 ? [mes, idsFiltrados] : [mes];

  const detalle = await pool.query(
    `SELECT g.*, a.nombre AS almacen_nombre, r.nombre AS region_nombre
     FROM gastos g
     JOIN almacenes a ON a.id = g.almacen_id
     LEFT JOIN regiones r ON r.id = a.region_id
     WHERE to_char(g.fecha,'YYYY-MM') = $1 ${condAlmacen}
     ORDER BY g.fecha DESC, a.nombre, g.creado_en DESC`,
    params
  );

  const porAlmacen = new Map();
  for (const g of detalle.rows) {
    const actual = porAlmacen.get(g.almacen_id) || { nombre: g.almacen_nombre, region: g.region_nombre, total: 0 };
    actual.total += Number(g.valor);
    porAlmacen.set(g.almacen_id, actual);
  }
  const subtotalesAlmacen = [...porAlmacen.values()].sort((a, b) => b.total - a.total);

  const porRegion = new Map();
  for (const f of subtotalesAlmacen) {
    const key = f.region || 'Sin región';
    porRegion.set(key, (porRegion.get(key) || 0) + f.total);
  }
  const subtotalesRegion = [...porRegion.entries()].map(([region, total]) => ({ region, total }));

  const totalGeneral = detalle.rows.reduce((acc, g) => acc + Number(g.valor), 0);

  res.render('jefa/gastos', {
    mes,
    almacenes: almacenes.rows,
    regiones: regiones.rows,
    almacenFiltro,
    regionFiltro,
    detalle: detalle.rows,
    subtotalesAlmacen,
    subtotalesRegion,
    totalGeneral,
  });
});

// --- Administración (solo rol admin) ---

router.get('/admin', async (req, res) => {
  if (req.session.usuario.rol !== 'admin') return res.status(403).render('403');
  const [almacenes, usuarios, regiones] = await Promise.all([
    pool.query(
      `SELECT a.*, r.nombre AS region_nombre FROM almacenes a
       LEFT JOIN regiones r ON r.id = a.region_id
       ORDER BY r.nombre NULLS LAST, a.nombre`
    ),
    pool.query(
      `SELECT u.*, a.nombre AS almacen_nombre FROM usuarios u
       LEFT JOIN almacenes a ON a.id = u.almacen_id ORDER BY u.rol, u.usuario`
    ),
    pool.query('SELECT * FROM regiones ORDER BY nombre'),
  ]);
  res.render('jefa/admin', {
    almacenes: almacenes.rows,
    usuarios: usuarios.rows,
    regiones: regiones.rows,
    mensaje: req.query.ok || null,
    tempPassword: req.query.pass || null,
    tempUsuario: req.query.u || null,
  });
});

router.post('/admin/regiones', async (req, res) => {
  if (req.session.usuario.rol !== 'admin') return res.status(403).render('403');
  const { nombre } = req.body;
  if (!nombre || !nombre.trim()) {
    return res.redirect('/jefa/admin');
  }
  await pool.query('INSERT INTO regiones (nombre) VALUES ($1) ON CONFLICT (nombre) DO NOTHING', [nombre.trim()]);
  res.redirect('/jefa/admin?ok=' + encodeURIComponent('Región creada.'));
});

router.post('/admin/almacenes', async (req, res) => {
  if (req.session.usuario.rol !== 'admin') return res.status(403).render('403');
  const { nombre, region_id } = req.body;
  if (!nombre || !nombre.trim()) {
    return res.redirect('/jefa/admin');
  }
  await pool.query(
    `INSERT INTO almacenes (nombre, region_id) VALUES ($1, $2)
     ON CONFLICT (nombre) DO UPDATE SET region_id = EXCLUDED.region_id`,
    [nombre.trim(), region_id || null]
  );
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
