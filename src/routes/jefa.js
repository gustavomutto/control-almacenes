const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');

const router = express.Router();

function hoyISO() {
  return new Date().toISOString().slice(0, 10);
}

const SQL_ALMACENES = `SELECT a.*, r.nombre AS region_nombre FROM almacenes a
  LEFT JOIN regiones r ON r.id = a.region_id
  ORDER BY r.nombre NULLS LAST, a.nombre`;

function agruparPorRegion(almacenes, filas) {
  const porId = Object.fromEntries(filas.map((f) => [f.almacen.id, f]));
  const regiones = [];
  const sinRegion = [];
  for (const a of almacenes) {
    const fila = porId[a.id];
    if (!fila) continue;
    if (a.region_id) {
      let g = regiones.find((r) => r.id === a.region_id);
      if (!g) {
        g = { id: a.region_id, nombre: a.region_nombre, filas: [] };
        regiones.push(g);
      }
      g.filas.push(fila);
    } else sinRegion.push(fila);
  }
  return { regiones, sinRegion };
}

function sumar(filas) {
  return filas.reduce(
    (acc, f) => ({
      venta: acc.venta + f.venta,
      costo: acc.costo + f.costo,
      margen: acc.margen + f.margen,
      gastos: acc.gastos + f.gastos,
      unidades: acc.unidades + (f.unidades || 0),
    }),
    { venta: 0, costo: 0, margen: 0, gastos: 0, unidades: 0 }
  );
}

// ======================= HOY =======================

router.get('/', async (req, res) => {
  const fecha = req.query.fecha || hoyISO();

  const [almacenes, ventas, gastos, unidades] = await Promise.all([
    pool.query(SQL_ALMACENES.replace('ORDER BY', 'WHERE a.activo = true ORDER BY')),
    pool.query(
      `SELECT almacen_id, COALESCE(SUM(total),0) AS venta, COALESCE(SUM(costo_total),0) AS costo,
              COALESCE(SUM(margen),0) AS margen, COUNT(*) AS facturas
       FROM documentos WHERE fecha = $1 AND tipo = 'factura' AND anulada = false
       GROUP BY almacen_id`,
      [fecha]
    ),
    pool.query(`SELECT almacen_id, COALESCE(SUM(valor),0) AS total FROM gastos WHERE fecha = $1 GROUP BY almacen_id`, [
      fecha,
    ]),
    pool.query(
      `SELECT d.almacen_id, a.nombre AS almacen_nombre, i.descripcion AS material,
              SUM(i.cantidad) AS cantidad, SUM(i.total) AS venta
       FROM documento_items i
       JOIN documentos d ON d.id = i.documento_id
       JOIN almacenes a ON a.id = d.almacen_id
       WHERE d.fecha = $1 AND d.tipo = 'factura' AND d.anulada = false
       GROUP BY d.almacen_id, a.nombre, i.descripcion
       ORDER BY a.nombre, cantidad DESC`,
      [fecha]
    ),
  ]);

  const vMap = Object.fromEntries(ventas.rows.map((r) => [r.almacen_id, r]));
  const gMap = Object.fromEntries(gastos.rows.map((r) => [r.almacen_id, r.total]));

  const filas = almacenes.rows.map((a) => ({
    almacen: a,
    venta: Number(vMap[a.id]?.venta || 0),
    costo: Number(vMap[a.id]?.costo || 0),
    margen: Number(vMap[a.id]?.margen || 0),
    facturas: Number(vMap[a.id]?.facturas || 0),
    gastos: Number(gMap[a.id] || 0),
  }));

  const { regiones, sinRegion } = agruparPorRegion(almacenes.rows, filas);
  const totalUnidades = unidades.rows.reduce((a, r) => a + Number(r.cantidad), 0);

  res.render('jefa/panel', {
    regiones,
    sinRegion,
    totales: sumar(filas),
    fecha,
    hoy: hoyISO(),
    unidadesHoy: unidades.rows,
    totalUnidadesHoy: totalUnidades,
    activo: 'panel',
  });
});

// ======================= REPORTE MENSUAL =======================

router.get('/reporte', async (req, res) => {
  const mes = req.query.mes || hoyISO().slice(0, 7);
  const almacenFiltro = req.query.almacen || 'todos';
  const regionFiltro = req.query.region || 'todas';

  const [almacenes, regiones] = await Promise.all([
    pool.query(SQL_ALMACENES),
    pool.query('SELECT * FROM regiones WHERE activo = true ORDER BY nombre'),
  ]);

  let filtrados = almacenes.rows;
  if (almacenFiltro !== 'todos') filtrados = filtrados.filter((a) => String(a.id) === String(almacenFiltro));
  else if (regionFiltro !== 'todas') filtrados = filtrados.filter((a) => String(a.region_id) === String(regionFiltro));
  const ids = filtrados.map((a) => a.id);

  const cond = ids.length ? 'AND almacen_id = ANY($2::int[])' : '';
  const primerDia = `${mes}-01`;
  const params = ids.length ? [primerDia, ids] : [primerDia];

  const [porAlmacen, porDia, gastos, unidades, unidadesAlmacen] = await Promise.all([
    pool.query(
      `SELECT almacen_id, COALESCE(SUM(total),0) AS venta, COALESCE(SUM(costo_total),0) AS costo,
              COALESCE(SUM(margen),0) AS margen, COUNT(*) AS facturas
       FROM documentos WHERE fecha >= $1::date AND fecha < ($1::date + INTERVAL '1 month') AND tipo = 'factura' AND anulada = false ${cond}
       GROUP BY almacen_id`,
      params
    ),
    pool.query(
      `SELECT fecha, COALESCE(SUM(total),0) AS venta, COALESCE(SUM(costo_total),0) AS costo,
              COALESCE(SUM(margen),0) AS margen
       FROM documentos WHERE fecha >= $1::date AND fecha < ($1::date + INTERVAL '1 month') AND tipo = 'factura' AND anulada = false ${cond}
       GROUP BY fecha ORDER BY fecha`,
      params
    ),
    pool.query(
      `SELECT almacen_id, COALESCE(SUM(valor),0) AS total FROM gastos
       WHERE fecha >= $1::date AND fecha < ($1::date + INTERVAL '1 month') ${cond} GROUP BY almacen_id`,
      params
    ),
    pool.query(
      `SELECT i.descripcion AS material, SUM(i.cantidad) AS cantidad, SUM(i.total) AS venta
       FROM documento_items i JOIN documentos d ON d.id = i.documento_id
       WHERE d.fecha >= $1::date AND d.fecha < ($1::date + INTERVAL '1 month') AND d.tipo = 'factura' AND d.anulada = false
             ${ids.length ? 'AND d.almacen_id = ANY($2::int[])' : ''}
       GROUP BY i.descripcion ORDER BY cantidad DESC LIMIT 50`,
      params
    ),
    pool.query(
      `SELECT d.almacen_id, COALESCE(SUM(i.cantidad),0) AS unidades
       FROM documento_items i JOIN documentos d ON d.id = i.documento_id
       WHERE d.fecha >= $1::date AND d.fecha < ($1::date + INTERVAL '1 month') AND d.tipo = 'factura' AND d.anulada = false
             ${ids.length ? 'AND d.almacen_id = ANY($2::int[])' : ''}
       GROUP BY d.almacen_id`,
      params
    ),
  ]);

  const vMap = Object.fromEntries(porAlmacen.rows.map((r) => [r.almacen_id, r]));
  const gMap = Object.fromEntries(gastos.rows.map((r) => [r.almacen_id, r.total]));
  const uMap = Object.fromEntries(unidadesAlmacen.rows.map((r) => [r.almacen_id, Number(r.unidades)]));

  const filasAlmacen = filtrados.map((a) => ({
    almacen: a,
    venta: Number(vMap[a.id]?.venta || 0),
    costo: Number(vMap[a.id]?.costo || 0),
    margen: Number(vMap[a.id]?.margen || 0),
    facturas: Number(vMap[a.id]?.facturas || 0),
    gastos: Number(gMap[a.id] || 0),
    unidades: uMap[a.id] || 0,
  }));

  res.render('jefa/reporte', {
    mes,
    almacenes: almacenes.rows,
    regiones: regiones.rows,
    almacenFiltro,
    regionFiltro,
    filasAlmacen,
    porDia: porDia.rows,
    totalGeneral: sumar(filasAlmacen),
    unidadesMaterial: unidades.rows.map((u) => ({ material: u.material, cantidad: Number(u.cantidad) })),
    activo: 'reporte',
  });
});

// ======================= INFORME DE GASTOS =======================

router.get('/gastos', async (req, res) => {
  const mes = req.query.mes || hoyISO().slice(0, 7);
  const almacenFiltro = req.query.almacen || 'todos';
  const regionFiltro = req.query.region || 'todas';

  const [almacenes, regiones] = await Promise.all([
    pool.query(SQL_ALMACENES),
    pool.query('SELECT * FROM regiones WHERE activo = true ORDER BY nombre'),
  ]);

  let filtrados = almacenes.rows;
  if (almacenFiltro !== 'todos') filtrados = filtrados.filter((a) => String(a.id) === String(almacenFiltro));
  else if (regionFiltro !== 'todas') filtrados = filtrados.filter((a) => String(a.region_id) === String(regionFiltro));
  const ids = filtrados.map((a) => a.id);

  const cond = ids.length ? 'AND g.almacen_id = ANY($2::int[])' : '';
  const primerDia = `${mes}-01`;
  const params = ids.length ? [primerDia, ids] : [primerDia];

  const detalle = await pool.query(
    `SELECT g.*, a.nombre AS almacen_nombre, r.nombre AS region_nombre
     FROM gastos g JOIN almacenes a ON a.id = g.almacen_id
     LEFT JOIN regiones r ON r.id = a.region_id
     WHERE g.fecha >= $1::date AND g.fecha < ($1::date + INTERVAL '1 month') ${cond}
     ORDER BY g.fecha DESC, a.nombre, g.creado_en DESC`,
    params
  );

  const porAlmacen = new Map();
  for (const g of detalle.rows) {
    const act = porAlmacen.get(g.almacen_id) || { nombre: g.almacen_nombre, region: g.region_nombre, total: 0 };
    act.total += Number(g.valor);
    porAlmacen.set(g.almacen_id, act);
  }
  const subtotalesAlmacen = [...porAlmacen.values()].sort((a, b) => b.total - a.total);

  const porRegion = new Map();
  for (const f of subtotalesAlmacen) {
    const k = f.region || 'Sin región';
    porRegion.set(k, (porRegion.get(k) || 0) + f.total);
  }

  res.render('jefa/gastos', {
    mes,
    almacenes: almacenes.rows,
    regiones: regiones.rows,
    almacenFiltro,
    regionFiltro,
    detalle: detalle.rows,
    subtotalesAlmacen,
    subtotalesRegion: [...porRegion.entries()].map(([region, total]) => ({ region, total })),
    totalGeneral: detalle.rows.reduce((a, g) => a + Number(g.valor), 0),
    activo: 'gastos',
  });
});

// ======================= COSTOS (solo admin/jefa) =======================
// Aquí es donde se define el precio de costo. El personal del almacén nunca lo ve.

router.get('/costos', async (req, res) => {
  const almacenes = await pool.query(SQL_ALMACENES);
  const almacenFiltro = req.query.almacen || (almacenes.rows[0] ? String(almacenes.rows[0].id) : '');

  const productos = almacenFiltro
    ? await pool.query(
        `SELECT p.*, (p.precio_venta - p.precio_costo) AS margen_unit
         FROM productos p WHERE p.almacen_id = $1 AND p.activo = true ORDER BY p.nombre`,
        [almacenFiltro]
      )
    : { rows: [] };

  const sinCosto = productos.rows.filter((p) => Number(p.precio_costo) === 0).length;

  res.render('jefa/costos', {
    almacenes: almacenes.rows,
    almacenFiltro,
    productos: productos.rows,
    sinCosto,
    mensaje: req.query.ok || null,
    activo: 'costos',
  });
});

router.post('/costos', async (req, res) => {
  const { almacen_id } = req.body;
  // Los campos llegan como costo_<idDelProducto> para que cada valor quede atado a su producto.
  const entradas = Object.entries(req.body)
    .filter(([clave]) => clave.startsWith('costo_'))
    .map(([clave, valor]) => [Number(clave.slice(6)), Number(valor)])
    .filter(([id, valor]) => Number.isInteger(id) && id > 0 && !Number.isNaN(valor) && valor >= 0);

  for (const [id, valor] of entradas) {
    await pool.query('UPDATE productos SET precio_costo = $1 WHERE id = $2 AND almacen_id = $3', [
      valor,
      id,
      almacen_id,
    ]);
  }
  res.redirect(
    `/jefa/costos?almacen=${almacen_id}&ok=` + encodeURIComponent(`${entradas.length} precios de costo guardados.`)
  );
});

// ======================= ADMINISTRACIÓN =======================

function soloAdmin(req, res, next) {
  if (req.session.usuario.rol !== 'admin' && req.session.usuario.rol !== 'jefa') {
    return res.status(403).render('403');
  }
  next();
}

router.get('/admin', soloAdmin, async (req, res) => {
  const [almacenes, usuarios, regiones] = await Promise.all([
    pool.query(`SELECT a.*, r.nombre AS region_nombre,
                  (SELECT count(*) FROM documentos d WHERE d.almacen_id = a.id) AS documentos
                FROM almacenes a LEFT JOIN regiones r ON r.id = a.region_id
                ORDER BY r.nombre NULLS LAST, a.nombre`),
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
    error: req.query.error || null,
    tempPassword: req.query.pass || null,
    tempUsuario: req.query.u || null,
    activo: 'admin',
  });
});

router.post('/admin/regiones', soloAdmin, async (req, res) => {
  const { nombre } = req.body;
  if (!nombre || !nombre.trim()) return res.redirect('/jefa/admin');
  await pool.query('INSERT INTO regiones (nombre) VALUES ($1) ON CONFLICT (nombre) DO NOTHING', [nombre.trim()]);
  res.redirect('/jefa/admin?ok=' + encodeURIComponent('Región creada.'));
});

router.post('/admin/regiones/:id/eliminar', soloAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT count(*) AS n FROM almacenes WHERE region_id = $1', [req.params.id]);
  if (Number(rows[0].n) > 0) {
    return res.redirect(
      '/jefa/admin?error=' + encodeURIComponent('Esa región todavía tiene almacenes. Muévelos o bórralos primero.')
    );
  }
  await pool.query('DELETE FROM regiones WHERE id = $1', [req.params.id]);
  res.redirect('/jefa/admin?ok=' + encodeURIComponent('Región eliminada.'));
});

router.post('/admin/almacenes', soloAdmin, async (req, res) => {
  const { nombre, region_id, papel } = req.body;
  if (!nombre || !nombre.trim()) return res.redirect('/jefa/admin');
  await pool.query(
    `INSERT INTO almacenes (nombre, region_id, papel, encabezado) VALUES ($1,$2,$3,$1)
     ON CONFLICT (nombre) DO UPDATE SET region_id = EXCLUDED.region_id, papel = EXCLUDED.papel`,
    [nombre.trim(), region_id || null, papel === '80mm' || papel === '58mm' ? papel : 'carta']
  );
  res.redirect('/jefa/admin?ok=' + encodeURIComponent('Almacén guardado.'));
});

router.post('/admin/almacenes/:id/actualizar', soloAdmin, async (req, res) => {
  const { region_id, papel } = req.body;
  await pool.query('UPDATE almacenes SET region_id = $1, papel = $2 WHERE id = $3', [
    region_id || null,
    papel === '80mm' || papel === '58mm' ? papel : 'carta',
    req.params.id,
  ]);
  res.redirect('/jefa/admin?ok=' + encodeURIComponent('Almacén actualizado.'));
});

// Borrar un almacén elimina TODO lo suyo (productos, facturas, gastos, usuarios).
// Por eso pide confirmación escribiendo el nombre exacto.
router.post('/admin/almacenes/:id/eliminar', soloAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT nombre FROM almacenes WHERE id = $1', [req.params.id]);
  if (rows.length === 0) return res.redirect('/jefa/admin?error=' + encodeURIComponent('Almacén no encontrado.'));

  if ((req.body.confirmacion || '').trim().toLowerCase() !== rows[0].nombre.trim().toLowerCase()) {
    return res.redirect(
      '/jefa/admin?error=' +
        encodeURIComponent(`Para borrar «${rows[0].nombre}» debes escribir su nombre exacto en la confirmación.`)
    );
  }

  await pool.query('DELETE FROM almacenes WHERE id = $1', [req.params.id]);
  res.redirect('/jefa/admin?ok=' + encodeURIComponent(`Almacén «${rows[0].nombre}» eliminado con todos sus datos.`));
});

function generarPassword() {
  const letras = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 10; i++) out += letras[Math.floor(Math.random() * letras.length)];
  return out;
}

router.post('/admin/usuarios', soloAdmin, async (req, res) => {
  const { nombre, usuario, rol, almacen_id } = req.body;
  if (!nombre || !usuario || !rol) return res.redirect('/jefa/admin');
  if (rol === 'almacen' && !almacen_id) {
    return res.redirect('/jefa/admin?error=' + encodeURIComponent('Elige un almacén para este usuario.'));
  }

  const pass = generarPassword();
  const hash = await bcrypt.hash(pass, 10);
  const limpio = usuario.trim().toLowerCase();

  try {
    await pool.query(
      `INSERT INTO usuarios (almacen_id, usuario, password_hash, nombre, rol) VALUES ($1,$2,$3,$4,$5)`,
      [rol === 'almacen' ? almacen_id : null, limpio, hash, nombre.trim(), rol]
    );
  } catch (err) {
    return res.redirect('/jefa/admin?error=' + encodeURIComponent('Ese nombre de usuario ya existe.'));
  }

  res.redirect(
    `/jefa/admin?ok=${encodeURIComponent('Usuario creado.')}&u=${encodeURIComponent(limpio)}&pass=${encodeURIComponent(pass)}`
  );
});

// Cambiar el usuario de inicio de sesión, el nombre visible y el almacén.
router.post('/admin/usuarios/:id/editar', soloAdmin, async (req, res) => {
  const { usuario, nombre, almacen_id } = req.body;
  const limpio = (usuario || '').trim().toLowerCase();

  if (!limpio || !nombre || !nombre.trim()) {
    return res.redirect('/jefa/admin?error=' + encodeURIComponent('El usuario y el nombre no pueden quedar vacíos.'));
  }
  if (!/^[a-z0-9._-]+$/.test(limpio)) {
    return res.redirect(
      '/jefa/admin?error=' +
        encodeURIComponent('El usuario solo puede tener letras sin tildes, números, punto, guion o guion bajo.')
    );
  }

  const { rows } = await pool.query('SELECT rol, almacen_id FROM usuarios WHERE id = $1', [req.params.id]);
  if (rows.length === 0) return res.redirect('/jefa/admin?error=' + encodeURIComponent('Usuario no encontrado.'));

  // Solo el personal de almacén tiene almacén; jefa y admin no.
  const nuevoAlmacen = rows[0].rol === 'almacen' ? almacen_id || rows[0].almacen_id : null;

  try {
    await pool.query('UPDATE usuarios SET usuario = $1, nombre = $2, almacen_id = $3 WHERE id = $4', [
      limpio,
      nombre.trim(),
      nuevoAlmacen,
      req.params.id,
    ]);
  } catch (err) {
    return res.redirect('/jefa/admin?error=' + encodeURIComponent(`El usuario «${limpio}» ya está en uso.`));
  }

  // Si se cambió a sí mismo, refrescamos lo que quedó guardado en su sesión.
  if (Number(req.params.id) === req.session.usuario.id) {
    req.session.usuario.usuario = limpio;
    req.session.usuario.nombre = nombre.trim();
  }

  res.redirect('/jefa/admin?ok=' + encodeURIComponent('Usuario actualizado.'));
});

router.post('/admin/usuarios/:id/clave', soloAdmin, async (req, res) => {
  const pass = generarPassword();
  const hash = await bcrypt.hash(pass, 10);
  const { rows } = await pool.query(
    'UPDATE usuarios SET password_hash = $1 WHERE id = $2 RETURNING usuario',
    [hash, req.params.id]
  );
  if (rows.length === 0) return res.redirect('/jefa/admin');
  res.redirect(
    `/jefa/admin?ok=${encodeURIComponent('Clave nueva generada.')}&u=${encodeURIComponent(rows[0].usuario)}&pass=${encodeURIComponent(pass)}`
  );
});

router.post('/admin/usuarios/:id/desactivar', soloAdmin, async (req, res) => {
  await pool.query('UPDATE usuarios SET activo = NOT activo WHERE id = $1', [req.params.id]);
  res.redirect('/jefa/admin?ok=' + encodeURIComponent('Usuario actualizado.'));
});

module.exports = router;
