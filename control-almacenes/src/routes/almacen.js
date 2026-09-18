const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

function hoyISO() {
  return new Date().toISOString().slice(0, 10);
}

// Panel principal del almacén: catálogo, ventas y gastos de hoy.
router.get('/', async (req, res) => {
  const almacenId = req.session.usuario.almacenId;
  const fecha = req.query.fecha || hoyISO();

  const [materiales, ventasHoy, gastosHoy, totalesHoy, unidadesHoy] = await Promise.all([
    pool.query(
      'SELECT * FROM materiales WHERE almacen_id = $1 AND activo = true ORDER BY nombre',
      [almacenId]
    ),
    pool.query(
      `SELECT v.*, m.nombre AS material_nombre FROM ventas v
       LEFT JOIN materiales m ON m.id = v.material_id
       WHERE v.almacen_id = $1 AND v.fecha = $2 ORDER BY v.creado_en DESC`,
      [almacenId, fecha]
    ),
    pool.query(
      'SELECT * FROM gastos WHERE almacen_id = $1 AND fecha = $2 ORDER BY creado_en DESC',
      [almacenId, fecha]
    ),
    pool.query(
      `SELECT
         COALESCE(SUM(total_venta),0) AS total_venta,
         COALESCE(SUM(total_costo),0) AS total_costo,
         COALESCE(SUM(margen),0) AS margen
       FROM ventas WHERE almacen_id = $1 AND fecha = $2`,
      [almacenId, fecha]
    ),
    pool.query(
      `SELECT COALESCE(m.nombre, v.descripcion) AS material, m.unidad,
              SUM(v.cantidad) AS cantidad, SUM(v.total_venta) AS venta, SUM(v.margen) AS margen
       FROM ventas v LEFT JOIN materiales m ON m.id = v.material_id
       WHERE v.almacen_id = $1 AND v.fecha = $2
       GROUP BY COALESCE(m.nombre, v.descripcion), m.unidad
       ORDER BY cantidad DESC`,
      [almacenId, fecha]
    ),
  ]);

  const totalGastosHoy = gastosHoy.rows.reduce((acc, g) => acc + Number(g.valor), 0);
  const totalUnidadesHoy = unidadesHoy.rows.reduce((acc, u) => acc + Number(u.cantidad), 0);

  res.render('almacen/panel', {
    almacen: { id: almacenId, nombre: req.session.usuario.almacenNombre },
    materiales: materiales.rows,
    ventas: ventasHoy.rows,
    gastos: gastosHoy.rows,
    totales: totalesHoy.rows[0],
    totalGastosHoy,
    unidadesHoy: unidadesHoy.rows,
    totalUnidadesHoy,
    fecha,
    hoy: hoyISO(),
    mensaje: req.query.ok || null,
    error: req.query.error || null,
  });
});

// --- Materiales -----------------------------------------------------------

router.post('/materiales', async (req, res) => {
  const almacenId = req.session.usuario.almacenId;
  const { nombre, unidad, precio_costo, precio_venta } = req.body;

  if (!nombre || !nombre.trim()) {
    return res.redirect('/almacen?error=' + encodeURIComponent('El material necesita un nombre.'));
  }

  await pool.query(
    `INSERT INTO materiales (almacen_id, nombre, unidad, precio_costo, precio_venta)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (almacen_id, nombre)
     DO UPDATE SET unidad = EXCLUDED.unidad, precio_costo = EXCLUDED.precio_costo,
                   precio_venta = EXCLUDED.precio_venta, activo = true, actualizado_en = now()`,
    [almacenId, nombre.trim(), (unidad || 'unidad').trim(), Number(precio_costo) || 0, Number(precio_venta) || 0]
  );

  res.redirect('/almacen?ok=' + encodeURIComponent('Material guardado.'));
});

router.post('/materiales/:id/eliminar', async (req, res) => {
  const almacenId = req.session.usuario.almacenId;
  await pool.query('UPDATE materiales SET activo = false WHERE id = $1 AND almacen_id = $2', [
    req.params.id,
    almacenId,
  ]);
  res.redirect('/almacen?ok=' + encodeURIComponent('Material eliminado.'));
});

// --- Ventas -----------------------------------------------------------

router.post('/ventas', async (req, res) => {
  const almacenId = req.session.usuario.almacenId;
  const usuarioId = req.session.usuario.id;
  const { material_id, cantidad, fecha, descripcion, precio_costo_unit, precio_venta_unit } = req.body;

  const cant = Number(cantidad);
  if (!cant || cant <= 0) {
    return res.redirect('/almacen?error=' + encodeURIComponent('La cantidad debe ser mayor a cero.'));
  }

  let costoUnit, ventaUnit, desc, matId = null;

  if (material_id) {
    const { rows } = await pool.query(
      'SELECT * FROM materiales WHERE id = $1 AND almacen_id = $2',
      [material_id, almacenId]
    );
    if (rows.length === 0) {
      return res.redirect('/almacen?error=' + encodeURIComponent('Material no encontrado.'));
    }
    costoUnit = Number(rows[0].precio_costo);
    ventaUnit = Number(rows[0].precio_venta);
    desc = rows[0].nombre;
    matId = rows[0].id;
  } else {
    // Venta manual, sin catálogo
    costoUnit = Number(precio_costo_unit) || 0;
    ventaUnit = Number(precio_venta_unit) || 0;
    desc = (descripcion || 'Venta').trim();
  }

  const totalCosto = costoUnit * cant;
  const totalVenta = ventaUnit * cant;
  const margen = totalVenta - totalCosto;

  await pool.query(
    `INSERT INTO ventas
      (almacen_id, material_id, fecha, descripcion, cantidad, precio_costo_unit, precio_venta_unit, total_costo, total_venta, margen, registrado_por)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [almacenId, matId, fecha || hoyISO(), desc, cant, costoUnit, ventaUnit, totalCosto, totalVenta, margen, usuarioId]
  );

  res.redirect('/almacen?ok=' + encodeURIComponent('Venta registrada.'));
});

router.post('/ventas/:id/eliminar', async (req, res) => {
  const almacenId = req.session.usuario.almacenId;
  await pool.query('DELETE FROM ventas WHERE id = $1 AND almacen_id = $2', [req.params.id, almacenId]);
  res.redirect('/almacen?ok=' + encodeURIComponent('Venta eliminada.'));
});

// --- Gastos -----------------------------------------------------------

router.post('/gastos', async (req, res) => {
  const almacenId = req.session.usuario.almacenId;
  const usuarioId = req.session.usuario.id;
  const { concepto, categoria, valor, fecha } = req.body;

  const val = Number(valor);
  if (!concepto || !concepto.trim() || !val || val <= 0) {
    return res.redirect('/almacen?error=' + encodeURIComponent('El gasto necesita concepto y valor.'));
  }

  await pool.query(
    `INSERT INTO gastos (almacen_id, fecha, concepto, categoria, valor, registrado_por)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [almacenId, fecha || hoyISO(), concepto.trim(), (categoria || '').trim() || null, val, usuarioId]
  );

  res.redirect('/almacen?ok=' + encodeURIComponent('Gasto registrado.'));
});

router.post('/gastos/:id/eliminar', async (req, res) => {
  const almacenId = req.session.usuario.almacenId;
  await pool.query('DELETE FROM gastos WHERE id = $1 AND almacen_id = $2', [req.params.id, almacenId]);
  res.redirect('/almacen?ok=' + encodeURIComponent('Gasto eliminado.'));
});

// --- Reporte mensual propio ---

router.get('/reporte', async (req, res) => {
  const almacenId = req.session.usuario.almacenId;
  const mes = req.query.mes || hoyISO().slice(0, 7); // YYYY-MM

  const [porDia, totalMes, gastosMes] = await Promise.all([
    pool.query(
      `SELECT fecha, SUM(total_venta) AS venta, SUM(total_costo) AS costo, SUM(margen) AS margen
       FROM ventas WHERE almacen_id = $1 AND to_char(fecha, 'YYYY-MM') = $2
       GROUP BY fecha ORDER BY fecha`,
      [almacenId, mes]
    ),
    pool.query(
      `SELECT COALESCE(SUM(total_venta),0) AS venta, COALESCE(SUM(total_costo),0) AS costo, COALESCE(SUM(margen),0) AS margen
       FROM ventas WHERE almacen_id = $1 AND to_char(fecha, 'YYYY-MM') = $2`,
      [almacenId, mes]
    ),
    pool.query(
      `SELECT COALESCE(SUM(valor),0) AS total FROM gastos WHERE almacen_id = $1 AND to_char(fecha, 'YYYY-MM') = $2`,
      [almacenId, mes]
    ),
  ]);

  res.render('almacen/reporte', {
    almacen: { id: almacenId, nombre: req.session.usuario.almacenNombre },
    mes,
    porDia: porDia.rows,
    totalMes: totalMes.rows[0],
    totalGastosMes: gastosMes.rows[0].total,
  });
});

module.exports = router;
