const express = require('express');
const multer = require('multer');
const pool = require('../db/pool');
const { hoyISO } = require('../lib/fecha');
const { calcularTotales, MATERIALES_M2 } = require('../lib/calculos');
const { papelCss, fechaTexto, horaTexto } = require('../lib/impresion');
const { crearTraslado, anularTraslado, cargarTraslado, listarTraslados } = require('../lib/traslados');
const { movimientoDelDia, ultimosDias, movimientoExcel } = require('../lib/movimiento');
const { inventarioExcel } = require('../lib/importar');
const { revisarInventario, aplicarInventario, filasParaFormulario } = require('../lib/inventario');

const router = express.Router();

// El archivo de Excel se lee en memoria y se descarta; nunca se guarda en el servidor.
const subida = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

async function cargarAlmacen(almacenId) {
  const { rows } = await pool.query('SELECT * FROM almacenes WHERE id = $1', [almacenId]);
  return rows[0];
}

// ============================ FACTURAR ============================

router.get('/', async (req, res) => {
  const almacenId = req.session.usuario.almacenId;
  const [almacen, productos, ultima] = await Promise.all([
    cargarAlmacen(almacenId),
    pool.query(
      `SELECT id, nombre, unidad, precio_venta, existencias, controla_stock
       FROM productos WHERE almacen_id = $1 AND activo = true ORDER BY nombre`,
      [almacenId]
    ),
    pool.query(
      `SELECT id, numero FROM documentos
       WHERE almacen_id = $1 AND tipo = 'factura' ORDER BY id DESC LIMIT 1`,
      [almacenId]
    ),
  ]);

  const proximo = await pool.query(
    `SELECT COALESCE(MAX(numero),0) + 1 AS n FROM documentos WHERE almacen_id = $1 AND tipo = 'factura'`,
    [almacenId]
  );

  res.render('almacen/facturar', {
    almacen,
    productos: productos.rows,
    proximoNumero: proximo.rows[0].n,
    ultima: ultima.rows[0] || null,
    activo: 'facturar',
    mensaje: req.query.ok || null,
    error: req.query.error || null,
  });
});

// Crea una factura (o cotización) completa dentro de una transacción.
async function crearDocumento({ almacenId, usuarioId, tipo, cuerpo }) {
  const items = Array.isArray(cuerpo.items) ? cuerpo.items : [];
  if (items.length === 0) throw new Error('No hay productos en el documento.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Bloqueamos la fila del almacén para que dos ventas simultáneas no tomen el mismo número.
    await client.query('SELECT id FROM almacenes WHERE id = $1 FOR UPDATE', [almacenId]);
    const { rows: numRows } = await client.query(
      `SELECT COALESCE(MAX(numero),0) + 1 AS n FROM documentos WHERE almacen_id = $1 AND tipo = $2`,
      [almacenId, tipo]
    );
    const numero = numRows[0].n;

    // Costos actuales de los productos referenciados (foto del costo al facturar).
    const ids = items.map((i) => Number(i.producto_id)).filter((n) => Number.isInteger(n) && n > 0);
    const costos = new Map();
    const stock = new Map();
    if (ids.length > 0) {
      const { rows } = await client.query(
        'SELECT id, precio_costo, existencias, controla_stock, nombre FROM productos WHERE almacen_id = $1 AND id = ANY($2::int[])',
        [almacenId, ids]
      );
      for (const p of rows) {
        costos.set(p.id, Number(p.precio_costo));
        stock.set(p.id, p);
      }
    }

    const preparados = items.map((i) => {
      const cantidad = Number(i.cantidad) || 0;
      const precio = Number(i.precio_unit) || 0;
      const pid = Number(i.producto_id) || null;
      const costoUnit = pid && costos.has(pid) ? costos.get(pid) : 0;
      return {
        producto_id: pid && costos.has(pid) ? pid : null,
        descripcion: String(i.descripcion || '').slice(0, 200) || 'Producto',
        detalle: i.detalle ? String(i.detalle).slice(0, 80) : null,
        cantidad,
        precio_unit: precio,
        costo_unit: costoUnit,
        total: cantidad * precio,
      };
    });

    const tot = calcularTotales(preparados, cuerpo.descuento, cuerpo.iva);
    const costoTotal = preparados.reduce((acc, i) => acc + i.costo_unit * i.cantidad, 0);
    // La ganancia se mide contra lo realmente cobrado (sin IVA, ya descontado el descuento).
    const baseVenta = tot.subtotal - tot.descuento;
    const margen = baseVenta - costoTotal;

    const pagos = tipo === 'factura' && Array.isArray(cuerpo.pagos) ? cuerpo.pagos : [];
    const pagado = pagos.reduce((acc, p) => acc + (Number(p.valor) || 0), 0);
    const cambio = tipo === 'factura' ? Math.max(0, pagado - tot.total) : 0;

    const { rows: docRows } = await client.query(
      `INSERT INTO documentos
        (almacen_id, tipo, numero, fecha, cliente, m2, subtotal, descuento, iva, total, costo_total, margen, cambio, registrado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id`,
      [
        almacenId,
        tipo,
        numero,
        cuerpo.fecha || hoyISO(), // fecha del negocio, no la del servidor (UTC)
        String(cuerpo.cliente || '').slice(0, 160),
        cuerpo.m2 ? Number(cuerpo.m2) : null,
        tot.subtotal,
        tot.descuento,
        tot.iva,
        tot.total,
        costoTotal,
        margen,
        cambio,
        usuarioId,
      ]
    );
    const documentoId = docRows[0].id;

    for (const i of preparados) {
      await client.query(
        `INSERT INTO documento_items (documento_id, producto_id, descripcion, detalle, cantidad, precio_unit, costo_unit, total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [documentoId, i.producto_id, i.descripcion, i.detalle, i.cantidad, i.precio_unit, i.costo_unit, i.total]
      );

      // Solo las facturas mueven inventario; las cotizaciones no.
      if (tipo === 'factura' && i.producto_id && stock.get(i.producto_id)?.controla_stock) {
        await client.query('UPDATE productos SET existencias = existencias - $1 WHERE id = $2', [
          i.cantidad,
          i.producto_id,
        ]);
        await client.query(
          `INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, documento_id, registrado_por)
           VALUES ($1,'venta',$2,$3,$4)`,
          [i.producto_id, -i.cantidad, documentoId, usuarioId]
        );
      }
    }

    for (const p of pagos) {
      const valor = Number(p.valor) || 0;
      if (valor <= 0) continue;
      await client.query('INSERT INTO documento_pagos (documento_id, metodo, valor) VALUES ($1,$2,$3)', [
        documentoId,
        String(p.metodo || 'Efectivo').slice(0, 40),
        valor,
      ]);
    }

    await client.query('COMMIT');
    return { id: documentoId, numero };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

router.post('/facturar', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const doc = await crearDocumento({
      almacenId: req.session.usuario.almacenId,
      usuarioId: req.session.usuario.id,
      tipo: 'factura',
      cuerpo: req.body,
    });
    res.json({ ok: true, id: doc.id, numero: doc.numero, imprimir: `/almacen/imprimir/${doc.id}` });
  } catch (err) {
    console.error('Error al facturar:', err);
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ============================ COTIZAR ============================

router.get('/cotizar', async (req, res) => {
  const almacenId = req.session.usuario.almacenId;
  const [almacen, productos] = await Promise.all([
    cargarAlmacen(almacenId),
    pool.query(
      `SELECT id, nombre, unidad, precio_venta, existencias, controla_stock
       FROM productos WHERE almacen_id = $1 AND activo = true ORDER BY nombre`,
      [almacenId]
    ),
  ]);

  res.render('almacen/cotizar', {
    almacen,
    productos: productos.rows,
    materialesM2: MATERIALES_M2,
    activo: 'cotizar',
  });
});

router.post('/cotizar', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const doc = await crearDocumento({
      almacenId: req.session.usuario.almacenId,
      usuarioId: req.session.usuario.id,
      tipo: 'cotizacion',
      cuerpo: req.body,
    });
    res.json({ ok: true, id: doc.id, numero: doc.numero, imprimir: `/almacen/imprimir/${doc.id}` });
  } catch (err) {
    console.error('Error al cotizar:', err);
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ============================ HISTORIAL ============================

router.get('/documentos', async (req, res) => {
  const almacenId = req.session.usuario.almacenId;
  const fecha = req.query.fecha || hoyISO();
  const tipo = req.query.tipo === 'cotizacion' ? 'cotizacion' : 'factura';

  const [almacen, docs] = await Promise.all([
    cargarAlmacen(almacenId),
    pool.query(
      `SELECT d.*, u.nombre AS vendedor,
              (SELECT string_agg(p.metodo || ': ' || to_char(p.valor,'FM999G999G999'), ', ')
                 FROM documento_pagos p WHERE p.documento_id = d.id) AS pagos
       FROM documentos d LEFT JOIN usuarios u ON u.id = d.registrado_por
       WHERE d.almacen_id = $1 AND d.fecha = $2 AND d.tipo = $3
       ORDER BY d.numero DESC`,
      [almacenId, fecha, tipo]
    ),
  ]);

  const total = docs.rows.filter((d) => !d.anulada).reduce((acc, d) => acc + Number(d.total), 0);

  res.render('almacen/documentos', {
    almacen,
    documentos: docs.rows,
    fecha,
    tipo,
    total,
    hoy: hoyISO(),
    activo: 'documentos',
  });
});

router.post('/documentos/:id/anular', async (req, res) => {
  const almacenId = req.session.usuario.almacenId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM documentos WHERE id = $1 AND almacen_id = $2 AND tipo = 'factura' AND anulada = false`,
      [req.params.id, almacenId]
    );
    if (rows.length === 0) throw new Error('Factura no encontrada o ya anulada.');

    // Devolver al inventario lo que se había descontado.
    const { rows: items } = await client.query(
      'SELECT producto_id, cantidad FROM documento_items WHERE documento_id = $1 AND producto_id IS NOT NULL',
      [req.params.id]
    );
    for (const i of items) {
      await client.query(
        'UPDATE productos SET existencias = existencias + $1 WHERE id = $2 AND controla_stock = true',
        [i.cantidad, i.producto_id]
      );
      await client.query(
        `INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, documento_id, nota, registrado_por)
         VALUES ($1,'anulacion',$2,$3,'Factura anulada',$4)`,
        [i.producto_id, i.cantidad, req.params.id, req.session.usuario.id]
      );
    }

    await client.query('UPDATE documentos SET anulada = true, margen = 0, costo_total = 0 WHERE id = $1', [
      req.params.id,
    ]);
    await client.query('COMMIT');
    res.redirect('/almacen/documentos?ok=' + encodeURIComponent('Factura anulada.'));
  } catch (err) {
    await client.query('ROLLBACK');
    res.redirect('/almacen/documentos?error=' + encodeURIComponent(err.message));
  } finally {
    client.release();
  }
});

// ============================ PRODUCTOS / INVENTARIO ============================

router.get('/productos', async (req, res) => {
  const almacenId = req.session.usuario.almacenId;
  const [almacen, productos] = await Promise.all([
    cargarAlmacen(almacenId),
    pool.query('SELECT * FROM productos WHERE almacen_id = $1 ORDER BY activo DESC, nombre', [almacenId]),
  ]);
  res.render('almacen/productos', {
    almacen,
    productos: productos.rows,
    activo: 'productos',
    mensaje: req.query.ok || null,
    error: req.query.error || null,
  });
});

router.post('/productos', async (req, res) => {
  const almacenId = req.session.usuario.almacenId;
  const { nombre, unidad, precio_venta, existencias, controla_stock } = req.body;
  if (!nombre || !nombre.trim()) {
    return res.redirect('/almacen/productos?error=' + encodeURIComponent('El producto necesita un nombre.'));
  }
  // Ojo: el personal del almacén NO define el precio de costo; eso lo hacen admin/jefa.
  await pool.query(
    `INSERT INTO productos (almacen_id, nombre, unidad, precio_venta, existencias, controla_stock)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (almacen_id, nombre) DO UPDATE
       SET unidad = EXCLUDED.unidad, precio_venta = EXCLUDED.precio_venta,
           controla_stock = EXCLUDED.controla_stock, activo = true, actualizado_en = now()`,
    [
      almacenId,
      nombre.trim(),
      (unidad || 'unidad').trim(),
      Number(precio_venta) || 0,
      Number(existencias) || 0,
      controla_stock !== undefined,
    ]
  );
  res.redirect('/almacen/productos?ok=' + encodeURIComponent('Producto guardado.'));
});

router.post('/productos/:id/entrada', async (req, res) => {
  const almacenId = req.session.usuario.almacenId;
  const cantidad = Number(req.body.cantidad);
  if (!cantidad) {
    return res.redirect('/almacen/productos?error=' + encodeURIComponent('Indica la cantidad que entró.'));
  }
  const { rowCount } = await pool.query(
    'UPDATE productos SET existencias = existencias + $1 WHERE id = $2 AND almacen_id = $3',
    [cantidad, req.params.id, almacenId]
  );
  if (rowCount > 0) {
    await pool.query(
      `INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, nota, registrado_por)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.params.id, cantidad > 0 ? 'entrada' : 'ajuste', cantidad, req.body.nota || null, req.session.usuario.id]
    );
  }
  res.redirect('/almacen/productos?ok=' + encodeURIComponent('Inventario actualizado.'));
});

router.post('/productos/:id/eliminar', async (req, res) => {
  const almacenId = req.session.usuario.almacenId;
  await pool.query('UPDATE productos SET activo = false WHERE id = $1 AND almacen_id = $2', [
    req.params.id,
    almacenId,
  ]);
  res.redirect('/almacen/productos?ok=' + encodeURIComponent('Producto desactivado.'));
});

// ============================ CAJA DEL DÍA ============================

async function resumenCaja(almacenId, fecha) {
  const [facturas, metodos, gastos] = await Promise.all([
    pool.query(
      `SELECT numero, total FROM documentos
       WHERE almacen_id = $1 AND fecha = $2 AND tipo = 'factura' AND anulada = false
       ORDER BY numero`,
      [almacenId, fecha]
    ),
    pool.query(
      `SELECT p.metodo, SUM(p.valor) AS valor
       FROM documento_pagos p JOIN documentos d ON d.id = p.documento_id
       WHERE d.almacen_id = $1 AND d.fecha = $2 AND d.tipo = 'factura' AND d.anulada = false
       GROUP BY p.metodo ORDER BY p.metodo`,
      [almacenId, fecha]
    ),
    pool.query('SELECT * FROM gastos WHERE almacen_id = $1 AND fecha = $2 ORDER BY creado_en', [almacenId, fecha]),
  ]);

  const total = facturas.rows.reduce((acc, f) => acc + Number(f.total), 0);
  const totalGastos = gastos.rows.reduce((acc, g) => acc + Number(g.valor), 0);
  const efectivo = metodos.rows
    .filter((m) => /efectivo/i.test(m.metodo))
    .reduce((acc, m) => acc + Number(m.valor), 0);

  return {
    facturas: facturas.rows,
    metodos: metodos.rows.map((m) => ({ metodo: m.metodo, valor: Number(m.valor) })),
    gastos: gastos.rows,
    cantidad: facturas.rows.length,
    total,
    totalGastos,
    efectivo,
    entregar: efectivo - totalGastos,
  };
}

router.get('/caja', async (req, res) => {
  const almacenId = req.session.usuario.almacenId;
  const fecha = req.query.fecha || hoyISO();
  const [almacen, resumen] = await Promise.all([cargarAlmacen(almacenId), resumenCaja(almacenId, fecha)]);
  res.render('almacen/caja', {
    almacen,
    resumen,
    fecha,
    hoy: hoyISO(),
    activo: 'caja',
    mensaje: req.query.ok || null,
  });
});

router.post('/gastos', async (req, res) => {
  const almacenId = req.session.usuario.almacenId;
  const { concepto, categoria, valor, fecha } = req.body;
  const val = Number(valor);
  if (!concepto || !concepto.trim() || !val || val <= 0) {
    return res.redirect(`/almacen/caja?fecha=${fecha || hoyISO()}`);
  }
  await pool.query(
    `INSERT INTO gastos (almacen_id, fecha, concepto, categoria, valor, registrado_por)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [almacenId, fecha || hoyISO(), concepto.trim(), (categoria || '').trim() || null, val, req.session.usuario.id]
  );
  res.redirect(`/almacen/caja?fecha=${fecha || hoyISO()}&ok=` + encodeURIComponent('Gasto registrado.'));
});

router.post('/gastos/:id/eliminar', async (req, res) => {
  const almacenId = req.session.usuario.almacenId;
  const fecha = req.body.fecha || hoyISO();
  await pool.query('DELETE FROM gastos WHERE id = $1 AND almacen_id = $2', [req.params.id, almacenId]);
  res.redirect(`/almacen/caja?fecha=${fecha}&ok=` + encodeURIComponent('Gasto eliminado.'));
});

// ============ INVENTARIO POR EXCEL (descargar, llenar y volver a subir) ============
// El personal del almacén nunca ve ni cambia el precio de costo: ni baja en el archivo
// ni se toca al subirlo, aunque alguien le agregue esa columna a mano.

router.get('/productos/excel', async (req, res) => {
  const almacenId = req.session.usuario.almacenId;
  const [almacen, productos] = await Promise.all([
    cargarAlmacen(almacenId),
    pool.query(
      `SELECT nombre, unidad, precio_venta, existencias, controla_stock
       FROM productos WHERE almacen_id = $1 AND activo = true ORDER BY nombre`,
      [almacenId]
    ),
  ]);

  const archivo = `inventario_${almacen.nombre.replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${archivo}"`);
  res.send(inventarioExcel(productos.rows, { conCosto: false }));
});

router.post('/productos/importar', subida.single('archivo'), async (req, res) => {
  const almacenId = req.session.usuario.almacenId;
  if (!req.file) {
    return res.redirect('/almacen/productos?error=' + encodeURIComponent('Elige el archivo de Excel.'));
  }

  let revision;
  try {
    revision = await revisarInventario(pool, almacenId, req.file.buffer);
  } catch (err) {
    return res.redirect(
      '/almacen/productos?error=' + encodeURIComponent('No pude leer el archivo. ¿Es un Excel (.xlsx) o un CSV?')
    );
  }
  if (revision.filas.length === 0) {
    return res.redirect(
      '/almacen/productos?error=' + encodeURIComponent(revision.errores[0] || 'El archivo no tiene productos.')
    );
  }

  const almacen = await cargarAlmacen(almacenId);
  res.render('almacen/importar', {
    almacen,
    previo: {
      ...revision,
      modoExistencias: req.body.modo_existencias === 'sumar' ? 'sumar' : 'reemplazar',
      nombreArchivo: req.file.originalname,
      filasFormulario: filasParaFormulario(revision.filas, false),
    },
    activo: 'productos',
  });
});

router.post('/productos/importar/aplicar', async (req, res) => {
  const almacenId = req.session.usuario.almacenId;
  let filas;
  try {
    filas = JSON.parse(req.body.filas || '[]');
  } catch (err) {
    return res.redirect('/almacen/productos?error=' + encodeURIComponent('Se perdió la vista previa. Sube el archivo otra vez.'));
  }

  try {
    const { creados, actualizados } = await aplicarInventario(pool, {
      almacenId,
      filas,
      modo: req.body.modo_existencias,
      conCosto: false,
    });
    res.redirect(
      '/almacen/productos?ok=' +
        encodeURIComponent(`Listo: ${creados} producto(s) nuevo(s) y ${actualizados} actualizado(s).`)
    );
  } catch (err) {
    console.error('Error importando inventario del almacén:', err);
    res.redirect('/almacen/productos?error=' + encodeURIComponent('No se pudo guardar: ' + err.message));
  }
});

// ============================ MOVIMIENTO DEL DÍA ============================
// Qué material salió hoy: vendido, trasladado a otro almacén y lo que entró.

router.get('/movimiento', async (req, res) => {
  const almacenId = req.session.usuario.almacenId;
  const fecha = req.query.fecha || hoyISO();
  const [almacen, movimiento, dias] = await Promise.all([
    cargarAlmacen(almacenId),
    movimientoDelDia(pool, almacenId, fecha),
    ultimosDias(pool, almacenId, 15),
  ]);
  res.render('almacen/movimiento', { almacen, movimiento, dias, fecha, hoy: hoyISO(), activo: 'movimiento' });
});

router.get('/movimiento/excel', async (req, res) => {
  const almacenId = req.session.usuario.almacenId;
  const fecha = req.query.fecha || hoyISO();
  const [almacen, movimiento] = await Promise.all([
    cargarAlmacen(almacenId),
    movimientoDelDia(pool, almacenId, fecha),
  ]);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="material_vendido_${fecha}.xlsx"`);
  res.send(movimientoExcel(movimiento, { almacenNombre: almacen.nombre, fecha }));
});

router.get('/movimiento/imprimir', async (req, res) => {
  const almacenId = req.session.usuario.almacenId;
  const fecha = req.query.fecha || hoyISO();
  const [almacen, movimiento] = await Promise.all([
    cargarAlmacen(almacenId),
    movimientoDelDia(pool, almacenId, fecha),
  ]);
  res.render('imprimir_movimiento', {
    almacen,
    movimiento,
    fecha,
    papelCss: papelCss(almacen.papel),
    hora: horaTexto(),
    fechaTexto: fechaTexto(fecha),
    auto: req.query.auto !== '0',
  });
});

// ============================ TRASLADOS ============================
// Mandar mercancía a otro almacén. No es una venta: no lleva precio.

router.get('/traslados', async (req, res) => {
  const almacenId = req.session.usuario.almacenId;
  const fecha = req.query.fecha || hoyISO();

  const [almacen, destinos, productos, historial] = await Promise.all([
    cargarAlmacen(almacenId),
    pool.query('SELECT id, nombre FROM almacenes WHERE activo = true AND id <> $1 ORDER BY nombre', [almacenId]),
    pool.query(
      `SELECT id, nombre, unidad, existencias, controla_stock
       FROM productos WHERE almacen_id = $1 AND activo = true ORDER BY nombre`,
      [almacenId]
    ),
    listarTraslados(pool, { almacenId, limite: 60 }),
  ]);

  const proximo = await pool.query('SELECT COALESCE(MAX(numero),0) + 1 AS n FROM traslados WHERE origen_id = $1', [
    almacenId,
  ]);

  res.render('almacen/traslados', {
    almacen,
    destinos: destinos.rows,
    productos: productos.rows,
    historial,
    proximoNumero: proximo.rows[0].n,
    fecha,
    hoy: hoyISO(),
    activo: 'traslados',
    mensaje: req.query.ok || null,
    error: req.query.error || null,
  });
});

router.post('/traslados', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const t = await crearTraslado(pool, {
      origenId: req.session.usuario.almacenId,
      destinoId: req.body.destino_id,
      usuarioId: req.session.usuario.id,
      cuerpo: req.body,
    });
    res.json({ ok: true, id: t.id, numero: t.numero, imprimir: `/almacen/traslados/imprimir/${t.id}` });
  } catch (err) {
    console.error('Error al trasladar:', err);
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/traslados/:id/anular', async (req, res) => {
  try {
    await anularTraslado(pool, {
      trasladoId: req.params.id,
      almacenId: req.session.usuario.almacenId,
      usuarioId: req.session.usuario.id,
    });
    res.redirect('/almacen/traslados?ok=' + encodeURIComponent('Traslado anulado; la mercancía volvió a su almacén.'));
  } catch (err) {
    res.redirect('/almacen/traslados?error=' + encodeURIComponent(err.message));
  }
});

router.get('/traslados/imprimir/:id', async (req, res) => {
  const almacenId = req.session.usuario.almacenId;
  const datos = await cargarTraslado(pool, req.params.id, almacenId);
  if (!datos) return res.status(404).render('404');

  const almacen = await cargarAlmacen(almacenId);
  res.render('imprimir_traslado', {
    almacen,
    traslado: datos.traslado,
    items: datos.items,
    papelCss: papelCss(almacen.papel),
    hora: horaTexto(datos.traslado.creado_en),
    fechaTexto: fechaTexto(datos.traslado.fecha),
    volver: '/almacen/traslados',
    auto: req.query.auto !== '0',
  });
});

// ============================ DATOS DEL ALMACÉN ============================

router.get('/datos', async (req, res) => {
  const almacen = await cargarAlmacen(req.session.usuario.almacenId);
  res.render('almacen/datos', { almacen, activo: 'datos', mensaje: req.query.ok || null });
});

router.post('/datos', async (req, res) => {
  const almacenId = req.session.usuario.almacenId;
  const { encabezado, direccion, nit, telefono, nota, metodos_pago, iva_por_defecto } = req.body;
  await pool.query(
    `UPDATE almacenes SET encabezado = $1, direccion = $2, nit = $3, telefono = $4, nota = $5,
            metodos_pago = $6, iva_por_defecto = $7
     WHERE id = $8`,
    [
      (encabezado || '').trim(),
      (direccion || '').trim(),
      (nit || '').trim(),
      (telefono || '').trim(),
      (nota || '').trim(),
      (metodos_pago || 'Efectivo,Transferencia').trim(),
      iva_por_defecto !== undefined,
      almacenId,
    ]
  );
  res.redirect('/almacen/datos?ok=' + encodeURIComponent('Datos guardados.'));
});

// ============================ IMPRESIÓN ============================

router.get('/imprimir/:id', async (req, res) => {
  const almacenId = req.session.usuario.almacenId;
  const datos = await cargarImpresion(almacenId, req.params.id);
  if (!datos) return res.status(404).render('404');

  const { doc, items, pagos } = datos;
  const almacen = {
    nombre: doc.almacen_nombre,
    encabezado: doc.encabezado,
    direccion: doc.direccion,
    nit: doc.nit,
    telefono: doc.telefono,
    nota: doc.nota,
    papel: doc.papel,
  };

  res.render('imprimir', {
    almacen,
    doc,
    items,
    pagos,
    papelCss: papelCss(doc.papel),
    hora: horaTexto(doc.creado_en),
    fechaTexto: fechaTexto(doc.fecha),
    volver: doc.tipo === 'factura' ? '/almacen' : '/almacen/cotizar',
    auto: req.query.auto !== '0',
  });
});

router.get('/caja/imprimir', async (req, res) => {
  const almacenId = req.session.usuario.almacenId;
  const fecha = req.query.fecha || hoyISO();
  const [almacen, resumen] = await Promise.all([cargarAlmacen(almacenId), resumenCaja(almacenId, fecha)]);
  res.render('imprimir_cierre', {
    almacen,
    resumen,
    fecha,
    papelCss: papelCss(almacen.papel),
    hora: horaTexto(),
    fechaTexto: fechaTexto(fecha),
    auto: req.query.auto !== '0',
  });
});

async function cargarImpresion(almacenId, documentoId) {
  const { rows } = await pool.query(
    `SELECT d.*, a.nombre AS almacen_nombre, a.encabezado, a.direccion, a.nit, a.telefono, a.nota, a.papel,
            u.nombre AS vendedor
     FROM documentos d
     JOIN almacenes a ON a.id = d.almacen_id
     LEFT JOIN usuarios u ON u.id = d.registrado_por
     WHERE d.id = $1 AND d.almacen_id = $2`,
    [documentoId, almacenId]
  );
  if (rows.length === 0) return null;

  const [items, pagos] = await Promise.all([
    pool.query('SELECT * FROM documento_items WHERE documento_id = $1 ORDER BY id', [documentoId]),
    pool.query('SELECT * FROM documento_pagos WHERE documento_id = $1 ORDER BY id', [documentoId]),
  ]);

  return { doc: rows[0], items: items.rows, pagos: pagos.rows };
}

module.exports = router;
module.exports.cargarImpresion = cargarImpresion;
