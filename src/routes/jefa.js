const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const pool = require('../db/pool');
const { hoyISO } = require('../lib/fecha');
const { plantillaExcel, inventarioExcel } = require('../lib/importar');
const { revisarInventario, aplicarInventario, filasParaFormulario } = require('../lib/inventario');
const { detectarInvertidos, repararInvertidos, repararCostos } = require('../lib/reparar');
const { crearTraslado, anularTraslado, cargarTraslado, listarTraslados } = require('../lib/traslados');
const { papelCss, fechaTexto, horaTexto } = require('../lib/impresion');

const router = express.Router();

// El archivo se lee en memoria y se descarta; nunca se guarda en el servidor.
const subida = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});

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
  const busqueda = String(req.query.q || '').trim();
  const soloSinCosto = req.query.sin === '1';

  // El resumen cuenta sobre TODO el almacén; la tabla muestra solo lo filtrado.
  const [conteos, productos] = await Promise.all([
    almacenFiltro
      ? pool.query(
          `SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE precio_costo = 0)::int AS sin_costo,
                  COUNT(*) FILTER (WHERE precio_costo > precio_venta AND precio_venta > 0)::int AS invertidos
           FROM productos WHERE almacen_id = $1 AND activo = true`,
          [almacenFiltro]
        )
      : { rows: [{ total: 0, sin_costo: 0, invertidos: 0 }] },
    almacenFiltro
      ? pool.query(
          `SELECT p.*, (p.precio_venta - p.precio_costo) AS margen_unit
           FROM productos p
           WHERE p.almacen_id = $1 AND p.activo = true
                 AND ($2 = '' OR p.nombre ILIKE '%' || $2 || '%')
                 AND ($3::boolean = false OR p.precio_costo = 0)
           ORDER BY p.nombre
           LIMIT 400`,
          [almacenFiltro, busqueda, soloSinCosto]
        )
      : { rows: [] },
  ]);

  res.render('jefa/costos', {
    almacenes: almacenes.rows,
    almacenFiltro,
    busqueda,
    soloSinCosto,
    productos: productos.rows,
    sinCosto: conteos.rows[0].sin_costo,
    invertidos: conteos.rows[0].invertidos,
    totalProductos: conteos.rows[0].total,
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
  const vuelta = new URLSearchParams({ almacen: String(almacen_id) });
  if (req.body.q) vuelta.set('q', req.body.q);
  if (req.body.sin === '1') vuelta.set('sin', '1');
  vuelta.set(
    'ok',
    `${entradas.length} precio(s) de costo guardados. Si ya habías vendido esos productos, entra a «Reparar» para` +
      ' actualizar la ganancia de esas facturas.'
  );
  res.redirect('/jefa/costos?' + vuelta.toString());
});

// ======================= REPARAR (precios invertidos y ganancia vieja) =======================
// Dos arreglos que no se pueden hacer desde las pantallas normales porque tocan facturas
// ya emitidas: cambiar venta por costo cuando el Excel vino al revés, y volver a calcular
// la ganancia de facturas hechas cuando el producto todavía no tenía costo.

function datosReparar(req) {
  return {
    almacenId: req.body.almacen_id || req.query.almacen || null,
    desde: (req.body.desde || req.query.desde || '').trim() || null,
  };
}

async function pantallaReparar(req, res, extra = {}) {
  const { almacenId, desde } = datosReparar(req);
  const almacenes = await pool.query(SQL_ALMACENES);
  const invertidos = await detectarInvertidos(pool, almacenId);

  res.render('jefa/reparar', {
    almacenes: almacenes.rows,
    almacenFiltro: almacenId ? String(almacenId) : '',
    desde: desde || '',
    invertidos,
    previo: null,
    mensaje: req.query.ok || null,
    error: req.query.error || null,
    activo: 'reparar',
    ...extra,
  });
}

router.get('/reparar', soloAdmin, (req, res) => pantallaReparar(req, res));

router.post('/reparar/invertidos', soloAdmin, async (req, res) => {
  const { almacenId, desde } = datosReparar(req);
  const aplicar = req.body.aplicar === '1';

  const ids = req.body.ids
    ? String(req.body.ids).split(',')
    : Object.keys(req.body)
        .filter((k) => k.startsWith('prod_'))
        .map((k) => k.slice(5));

  try {
    const previo = await repararInvertidos(pool, { almacenId, ids, desde, aplicar });
    if (aplicar) {
      return res.redirect(
        '/jefa/reparar?' +
          new URLSearchParams({
            almacen: almacenId || '',
            ok:
              `Listo: ${previo.cambiados} producto(s) corregidos, ${previo.lineas} línea(s) de factura y ` +
              `${previo.documentos} factura(s) recalculadas.`,
          }).toString()
      );
    }
    await pantallaReparar(req, res, { previo: { ...previo, tipo: 'invertidos', ids: ids.join(',') } });
  } catch (err) {
    console.error('Error reparando precios invertidos:', err);
    res.redirect('/jefa/reparar?error=' + encodeURIComponent(err.message));
  }
});

router.post('/reparar/costos', soloAdmin, async (req, res) => {
  const { almacenId, desde } = datosReparar(req);
  const aplicar = req.body.aplicar === '1';

  try {
    const previo = await repararCostos(pool, { almacenId, desde, aplicar });
    if (aplicar) {
      return res.redirect(
        '/jefa/reparar?' +
          new URLSearchParams({
            almacen: almacenId || '',
            ok: `Listo: ${previo.lineas} línea(s) y ${previo.documentos} factura(s) recalculadas con los costos de hoy.`,
          }).toString()
      );
    }
    await pantallaReparar(req, res, { previo: { ...previo, tipo: 'costos', ids: '' } });
  } catch (err) {
    console.error('Error recalculando facturas:', err);
    res.redirect('/jefa/reparar?error=' + encodeURIComponent(err.message));
  }
});

// ======================= TRASLADOS ENTRE ALMACENES =======================
// Admin/jefa puede mandar mercancía de cualquier almacén a cualquier otro, y ve el historial
// completo. El traslado no es una venta: no entra a la caja ni afecta la ganancia.

router.get('/traslados', async (req, res) => {
  const almacenFiltro = req.query.almacen || '';
  const desde = (req.query.desde || '').trim() || null;
  const hasta = (req.query.hasta || '').trim() || null;
  const origen = req.query.origen || almacenFiltro || '';

  const [almacenes, historial, productos] = await Promise.all([
    pool.query(SQL_ALMACENES),
    listarTraslados(pool, { almacenId: almacenFiltro || null, desde, hasta, limite: 200 }),
    origen
      ? pool.query(
          `SELECT id, nombre, unidad, existencias, controla_stock
           FROM productos WHERE almacen_id = $1 AND activo = true ORDER BY nombre`,
          [origen]
        )
      : { rows: [] },
  ]);

  res.render('jefa/traslados', {
    almacenes: almacenes.rows,
    almacenFiltro,
    origen: origen ? String(origen) : '',
    desde: desde || '',
    hasta: hasta || '',
    productos: productos.rows,
    historial,
    hoy: hoyISO(),
    activo: 'traslados',
    mensaje: req.query.ok || null,
    error: req.query.error || null,
  });
});

router.post('/traslados', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const t = await crearTraslado(pool, {
      origenId: req.body.origen_id,
      destinoId: req.body.destino_id,
      usuarioId: req.session.usuario.id,
      cuerpo: req.body,
    });
    res.json({ ok: true, id: t.id, numero: t.numero, imprimir: `/jefa/traslados/imprimir/${t.id}` });
  } catch (err) {
    console.error('Error al trasladar:', err);
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/traslados/:id/anular', soloAdmin, async (req, res) => {
  try {
    await anularTraslado(pool, { trasladoId: req.params.id, usuarioId: req.session.usuario.id });
    res.redirect('/jefa/traslados?ok=' + encodeURIComponent('Traslado anulado; la mercancía volvió a su almacén.'));
  } catch (err) {
    res.redirect('/jefa/traslados?error=' + encodeURIComponent(err.message));
  }
});

router.get('/traslados/imprimir/:id', async (req, res) => {
  const datos = await cargarTraslado(pool, req.params.id, null);
  if (!datos) return res.status(404).render('404');

  const { rows } = await pool.query('SELECT * FROM almacenes WHERE id = $1', [datos.traslado.origen_id]);
  res.render('imprimir_traslado', {
    almacen: rows[0],
    traslado: datos.traslado,
    items: datos.items,
    papelCss: papelCss(rows[0].papel),
    hora: horaTexto(datos.traslado.creado_en),
    fechaTexto: fechaTexto(datos.traslado.fecha),
    volver: '/jefa/traslados',
    auto: req.query.auto !== '0',
  });
});

// ======================= IMPORTAR INVENTARIO DESDE EXCEL =======================

router.get('/importar', async (req, res) => {
  const almacenes = await pool.query(SQL_ALMACENES);
  res.render('jefa/importar', {
    almacenes: almacenes.rows,
    almacenFiltro: req.query.almacen || (almacenes.rows[0] ? String(almacenes.rows[0].id) : ''),
    previo: null,
    mensaje: req.query.ok || null,
    error: req.query.error || null,
    activo: 'importar',
  });
});

router.get('/importar/plantilla', (req, res) => {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="plantilla_inventario.xlsx"');
  res.send(plantillaExcel());
});

// Descargar el inventario que ya tiene un almacén, con costos, para editarlo y volverlo a subir.
router.get('/importar/inventario', async (req, res) => {
  const almacenId = req.query.almacen;
  if (!almacenId) return res.redirect('/jefa/importar?error=' + encodeURIComponent('Elige primero el almacén.'));

  const [almacen, productos] = await Promise.all([
    pool.query('SELECT nombre FROM almacenes WHERE id = $1', [almacenId]),
    pool.query(
      `SELECT nombre, unidad, precio_venta, precio_costo, existencias, controla_stock
       FROM productos WHERE almacen_id = $1 AND activo = true ORDER BY nombre`,
      [almacenId]
    ),
  ]);
  if (almacen.rows.length === 0) {
    return res.redirect('/jefa/importar?error=' + encodeURIComponent('Almacén no encontrado.'));
  }

  const archivo = `inventario_${almacen.rows[0].nombre.replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${archivo}"`);
  res.send(inventarioExcel(productos.rows, { conCosto: true }));
});

// Paso 1: leer el archivo y mostrar qué va a pasar, sin tocar la base de datos.
router.post('/importar/revisar', subida.single('archivo'), async (req, res) => {
  const almacenId = req.body.almacen_id;
  if (!req.file || !almacenId) {
    return res.redirect('/jefa/importar?error=' + encodeURIComponent('Elige el almacén y el archivo.'));
  }

  let revision;
  try {
    revision = await revisarInventario(pool, almacenId, req.file.buffer);
  } catch (err) {
    return res.redirect(
      '/jefa/importar?error=' + encodeURIComponent('No pude leer el archivo. ¿Es un Excel (.xlsx) o un CSV?')
    );
  }

  if (revision.filas.length === 0) {
    return res.redirect(
      '/jefa/importar?error=' + encodeURIComponent(revision.errores[0] || 'El archivo no tiene productos.')
    );
  }

  const almacenes = await pool.query(SQL_ALMACENES);
  res.render('jefa/importar', {
    almacenes: almacenes.rows,
    almacenFiltro: String(almacenId),
    previo: {
      ...revision,
      modoExistencias: req.body.modo_existencias === 'sumar' ? 'sumar' : 'reemplazar',
      nombreArchivo: req.file.originalname,
    },
    mensaje: null,
    error: null,
    activo: 'importar',
  });
});

// Paso 2: aplicar lo revisado.
router.post('/importar/aplicar', async (req, res) => {
  const almacenId = req.body.almacen_id;

  let filas;
  try {
    filas = JSON.parse(req.body.filas || '[]');
  } catch (err) {
    return res.redirect('/jefa/importar?error=' + encodeURIComponent('Se perdió la vista previa. Sube el archivo otra vez.'));
  }

  try {
    const { creados, actualizados } = await aplicarInventario(pool, {
      almacenId,
      filas,
      modo: req.body.modo_existencias,
      invertir: req.body.invertir === '1',
      conCosto: true, // admin/jefa sí manejan el precio de costo
    });
    res.redirect(
      `/jefa/importar?almacen=${almacenId}&ok=` +
        encodeURIComponent(`Listo: ${creados} producto(s) nuevo(s) y ${actualizados} actualizado(s).`)
    );
  } catch (err) {
    console.error('Error importando inventario:', err);
    res.redirect('/jefa/importar?error=' + encodeURIComponent('No se pudo guardar: ' + err.message));
  }
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

const CLAVE_MINIMA = 4;

router.post('/admin/usuarios', soloAdmin, async (req, res) => {
  const { nombre, usuario, rol, almacen_id, password } = req.body;
  if (!nombre || !usuario || !rol) return res.redirect('/jefa/admin');
  if (rol === 'almacen' && !almacen_id) {
    return res.redirect('/jefa/admin?error=' + encodeURIComponent('Elige un almacén para este usuario.'));
  }

  // La clave la escribe quien administra; no se genera sola.
  const clave = String(password || '');
  if (clave.length < CLAVE_MINIMA) {
    return res.redirect(
      '/jefa/admin?error=' + encodeURIComponent(`La clave debe tener al menos ${CLAVE_MINIMA} caracteres.`)
    );
  }

  const hash = await bcrypt.hash(clave, 10);
  const limpio = usuario.trim().toLowerCase();

  try {
    await pool.query(
      `INSERT INTO usuarios (almacen_id, usuario, password_hash, nombre, rol) VALUES ($1,$2,$3,$4,$5)`,
      [rol === 'almacen' ? almacen_id : null, limpio, hash, nombre.trim(), rol]
    );
  } catch (err) {
    return res.redirect('/jefa/admin?error=' + encodeURIComponent('Ese nombre de usuario ya existe.'));
  }

  res.redirect(`/jefa/admin?ok=` + encodeURIComponent(`Usuario «${limpio}» creado con la clave que escribiste.`));
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

// Poner una clave nueva escrita por quien administra (no generada al azar).
router.post('/admin/usuarios/:id/clave', soloAdmin, async (req, res) => {
  const clave = String(req.body.password || '');
  if (clave.length < CLAVE_MINIMA) {
    return res.redirect(
      '/jefa/admin?error=' + encodeURIComponent(`La clave debe tener al menos ${CLAVE_MINIMA} caracteres.`)
    );
  }

  const hash = await bcrypt.hash(clave, 10);
  const { rows } = await pool.query('UPDATE usuarios SET password_hash = $1 WHERE id = $2 RETURNING usuario', [
    hash,
    req.params.id,
  ]);
  if (rows.length === 0) return res.redirect('/jefa/admin?error=' + encodeURIComponent('Usuario no encontrado.'));

  res.redirect('/jefa/admin?ok=' + encodeURIComponent(`Clave de «${rows[0].usuario}» cambiada.`));
});

router.post('/admin/usuarios/:id/desactivar', soloAdmin, async (req, res) => {
  await pool.query('UPDATE usuarios SET activo = NOT activo WHERE id = $1', [req.params.id]);
  res.redirect('/jefa/admin?ok=' + encodeURIComponent('Usuario actualizado.'));
});

module.exports = router;
