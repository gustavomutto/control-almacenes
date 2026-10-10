const express = require('express');
const multer = require('multer');
const pool = require('../db/pool');
const { hoyISO } = require('../lib/fecha');
const { calcularTotales, MATERIALES_M2 } = require('../lib/calculos');
const {
  papelCss,
  fechaTexto,
  horaTexto,
  papelEfectivo,
  densidadFactura,
  NOMBRES_PAPEL,
  ALTO_MAXIMO,
} = require('../lib/impresion');
const { crearTraslado, anularTraslado, cargarTraslado, listarTraslados } = require('../lib/traslados');
const { movimientoDelDia, ultimosDias, movimientoExcel } = require('../lib/movimiento');
const { inventarioExcel } = require('../lib/importar');
const { revisarInventario, aplicarInventario, filasParaFormulario } = require('../lib/inventario');
const {
  BILLETES,
  MONEDAS,
  efectivoDeLaCaja,
  leerArqueo,
  guardarArqueo,
  borrarArqueo,
} = require('../lib/arqueo');

const router = express.Router();

// El archivo de Excel se lee en memoria y se descarta; nunca se guarda en el servidor.
const subida = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Si esta caja tiene bodega enlazada, la barra de arriba muestra su pestaña.
router.use(async (req, res, next) => {
  try {
    res.locals.bodega = req.session.usuario.almacenId ? await bodegaDe(req.session.usuario.almacenId) : null;
  } catch (err) {
    res.locals.bodega = null;
  }
  next();
});

// Las pantallas de catálogo trabajan sin recargar: mandan la petición por detrás y
// esperan JSON. Si alguien entra sin JavaScript, se responde con la redirección de siempre.
function pideJson(req) {
  return req.get('X-Requested-With') === 'fetch';
}

function responder(req, res, { json, destino, ok, error }) {
  if (pideJson(req)) {
    if (error) return res.status(400).json({ ok: false, error });
    return res.json({ ok: true, ...json });
  }
  const sep = destino.includes('?') ? '&' : '?';
  res.redirect(destino + sep + (error ? 'error=' : 'ok=') + encodeURIComponent(error || ok));
}

// Un producto tal como lo necesita la tabla del catálogo. Los numeric de Postgres llegan
// como texto; aquí quedan como números para que el navegador pueda formatearlos.
function comoFila(p) {
  return {
    id: p.id,
    nombre: p.nombre,
    unidad: p.unidad,
    precio_venta: Number(p.precio_venta),
    existencias: Number(p.existencias),
    controla_stock: p.controla_stock,
    activo: p.activo,
  };
}

async function leerProducto(id) {
  const { rows } = await pool.query('SELECT * FROM productos WHERE id = $1', [id]);
  return rows.length === 0 ? null : comoFila(rows[0]);
}

async function catalogoDe(almacenId) {
  const { rows } = await pool.query('SELECT * FROM productos WHERE almacen_id = $1 ORDER BY activo DESC, nombre', [
    almacenId,
  ]);
  return rows.map(comoFila);
}

async function cargarAlmacen(almacenId) {
  const { rows } = await pool.query('SELECT * FROM almacenes WHERE id = $1', [almacenId]);
  return rows[0];
}

function verdadero(v) {
  return v !== undefined && v !== null && v !== false && v !== 'false' && v !== '0' && v !== '';
}

// Las operaciones del catálogo (agregar, editar, entrada, quitar y devolver) son las mismas en
// el almacén y en la bodega: solo cambian a qué almacén apuntan y si se maneja precio de venta.
// Todas contestan JSON cuando la pantalla las llama por detrás, para no recargar la página.
function montarCatalogo({ prefijo, destino, lugar, conPrecio, almacenDe, previos = [] }) {
  const pasos = [...previos, express.json()];

  function fallo(req, res, err) {
    const error = err && err.code === '23505' ? 'Ya hay otro producto con ese nombre.' : err.message;
    responder(req, res, { destino, error });
  }

  // Agregar. Si ya existe uno con el mismo nombre no se duplica: se actualiza, y sus
  // existencias no se tocan (para eso está «Entró»).
  router.post(prefijo, pasos, async (req, res) => {
    try {
      const nombre = String(req.body.nombre || '').trim();
      if (!nombre) return responder(req, res, { destino, error: 'El producto necesita un nombre.' });

      // El personal del almacén NO define el precio de costo; eso lo hacen admin/jefa.
      const { rows } = await pool.query(
        `INSERT INTO productos (almacen_id, nombre, unidad, precio_venta, existencias, controla_stock)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (almacen_id, nombre) DO UPDATE
           SET unidad = EXCLUDED.unidad,
               precio_venta = CASE WHEN $7 THEN EXCLUDED.precio_venta ELSE productos.precio_venta END,
               controla_stock = EXCLUDED.controla_stock, activo = true, actualizado_en = now()
         RETURNING id, (xmax = 0) AS fue_creado`,
        [
          almacenDe(req),
          nombre,
          String(req.body.unidad || 'unidad').trim(),
          conPrecio ? Number(req.body.precio_venta) || 0 : 0,
          Number(req.body.existencias) || 0,
          verdadero(req.body.controla_stock),
          conPrecio,
        ]
      );

      responder(req, res, {
        destino,
        ok: 'Producto guardado.',
        json: {
          producto: await leerProducto(rows[0].id),
          mensaje: rows[0].fue_creado ? `«${nombre}» agregado.` : `«${nombre}» actualizado.`,
        },
      });
    } catch (err) {
      fallo(req, res, err);
    }
  });

  // Editar sin tocar nada del pasado: las facturas ya hechas guardan su propia copia de la
  // descripción y del precio, así que cambiar el nombre o el precio aquí no las altera.
  router.post(`${prefijo}/:id/editar`, pasos, async (req, res) => {
    try {
      const nombre = String(req.body.nombre || '').trim();
      if (!nombre) return responder(req, res, { destino, error: 'El producto necesita un nombre.' });

      const { rows } = await pool.query(
        `UPDATE productos
            SET nombre = $1, unidad = $2,
                precio_venta = CASE WHEN $3 THEN $4 ELSE precio_venta END,
                controla_stock = $5, actualizado_en = now()
          WHERE id = $6 AND almacen_id = $7
          RETURNING id`,
        [
          nombre,
          String(req.body.unidad || 'unidad').trim(),
          conPrecio,
          conPrecio ? Number(req.body.precio_venta) || 0 : 0,
          verdadero(req.body.controla_stock),
          req.params.id,
          almacenDe(req),
        ]
      );
      if (rows.length === 0) return responder(req, res, { destino, error: 'Producto no encontrado.' });

      responder(req, res, {
        destino,
        ok: 'Producto actualizado.',
        json: { producto: await leerProducto(rows[0].id), mensaje: `«${nombre}» actualizado.` },
      });
    } catch (err) {
      fallo(req, res, err);
    }
  });

  router.post(`${prefijo}/:id/entrada`, pasos, async (req, res) => {
    try {
      const cantidad = Number(req.body.cantidad);
      if (!cantidad) return responder(req, res, { destino, error: 'Indica la cantidad que entró.' });

      const { rowCount } = await pool.query(
        'UPDATE productos SET existencias = existencias + $1, actualizado_en = now() WHERE id = $2 AND almacen_id = $3',
        [cantidad, req.params.id, almacenDe(req)]
      );
      if (rowCount === 0) return responder(req, res, { destino, error: 'Producto no encontrado.' });

      await pool.query(
        `INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, nota, registrado_por)
         VALUES ($1,$2,$3,$4,$5)`,
        [req.params.id, cantidad > 0 ? 'entrada' : 'ajuste', cantidad, req.body.nota || null, req.session.usuario.id]
      );

      const producto = await leerProducto(req.params.id);
      responder(req, res, {
        destino,
        ok: 'Inventario actualizado.',
        json: {
          producto,
          mensaje: `${producto.nombre}: ahora hay ${producto.existencias} ${producto.unidad}.`,
        },
      });
    } catch (err) {
      fallo(req, res, err);
    }
  });

  // «Quitar» NO borra el producto: lo desactiva. Así las facturas viejas conservan su
  // descripción, su cantidad y su total, y el producto se puede devolver cuando vuelva.
  router.post(`${prefijo}/:id/eliminar`, pasos, async (req, res) => {
    try {
      const { rows } = await pool.query(
        'UPDATE productos SET activo = false, actualizado_en = now() WHERE id = $1 AND almacen_id = $2 RETURNING id, nombre',
        [req.params.id, almacenDe(req)]
      );
      if (rows.length === 0) return responder(req, res, { destino, error: 'Producto no encontrado.' });

      responder(req, res, {
        destino,
        ok: 'Producto quitado.',
        json: {
          producto: await leerProducto(rows[0].id),
          mensaje: `«${rows[0].nombre}» quitado de ${lugar}. Sus ventas anteriores no se tocan.`,
        },
      });
    } catch (err) {
      fallo(req, res, err);
    }
  });

  router.post(`${prefijo}/:id/activar`, pasos, async (req, res) => {
    try {
      const { rows } = await pool.query(
        'UPDATE productos SET activo = true, actualizado_en = now() WHERE id = $1 AND almacen_id = $2 RETURNING id, nombre',
        [req.params.id, almacenDe(req)]
      );
      if (rows.length === 0) return responder(req, res, { destino, error: 'Producto no encontrado.' });

      responder(req, res, {
        destino,
        ok: 'Producto devuelto.',
        json: { producto: await leerProducto(rows[0].id), mensaje: `«${rows[0].nombre}» vuelve a ${lugar}.` },
      });
    } catch (err) {
      fallo(req, res, err);
    }
  });
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

  // La vista previa debe verse en el papel de ESTA caja.
  almacen.papel = papelEfectivo(req.session.usuario, almacen);

  res.render('almacen/facturar', {
    almacen,
    papelNombre: NOMBRES_PAPEL[almacen.papel] || almacen.papel,
    productos: productos.rows,
    editando: null,
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

// ============================ EDITAR UN DOCUMENTO ============================
// Una factura mal hecha se corrige en vez de anularla y volverla a hacer: conserva su
// número y su fecha. Por dentro es como deshacerla y rehacerla: se devuelve al inventario
// lo que tenía, se descuenta lo nuevo y se vuelven a calcular totales, costo y ganancia.
// Todo en una transacción, y queda registrado quién la editó y cuándo.

// El personal del almacén solo corrige lo del día; admin y jefa, cualquier fecha.
// Las cotizaciones no mueven inventario ni caja, así que se pueden corregir siempre.
function puedeEditar(doc, usuario) {
  if (doc.anulada) return 'Esa factura está anulada: ya no se puede editar.';
  if (doc.tipo === 'cotizacion') return null;
  if (usuario.rol !== 'almacen') return null;
  const dia = doc.fecha instanceof Date
    ? `${doc.fecha.getFullYear()}-${String(doc.fecha.getMonth() + 1).padStart(2, '0')}-${String(doc.fecha.getDate()).padStart(2, '0')}`
    : String(doc.fecha).slice(0, 10);
  if (dia !== hoyISO()) {
    return 'Solo se pueden editar las facturas del día. Para una de otro día, pídeselo a la administración.';
  }
  return null;
}

async function cargarDocumentoEditable(almacenId, documentoId, usuario) {
  const { rows } = await pool.query('SELECT * FROM documentos WHERE id = $1 AND almacen_id = $2', [
    documentoId,
    almacenId,
  ]);
  if (rows.length === 0) return { error: 'Documento no encontrado.' };

  const impedimento = puedeEditar(rows[0], usuario);
  if (impedimento) return { error: impedimento };

  const [items, pagos] = await Promise.all([
    pool.query('SELECT * FROM documento_items WHERE documento_id = $1 ORDER BY id', [documentoId]),
    pool.query('SELECT * FROM documento_pagos WHERE documento_id = $1 ORDER BY id', [documentoId]),
  ]);
  return { doc: rows[0], items: items.rows, pagos: pagos.rows };
}

async function actualizarDocumento({ documentoId, almacenId, usuario, cuerpo }) {
  const items = Array.isArray(cuerpo.items) ? cuerpo.items : [];
  if (items.length === 0) throw new Error('No hay productos en el documento.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: docs } = await client.query(
      'SELECT * FROM documentos WHERE id = $1 AND almacen_id = $2 FOR UPDATE',
      [documentoId, almacenId]
    );
    if (docs.length === 0) throw new Error('Documento no encontrado.');
    const anterior = docs[0];

    const impedimento = puedeEditar(anterior, usuario);
    if (impedimento) throw new Error(impedimento);

    // 1. Deshacer: lo que la factura había descontado vuelve al inventario.
    if (anterior.tipo === 'factura') {
      const { rows: viejos } = await client.query(
        'SELECT producto_id, cantidad FROM documento_items WHERE documento_id = $1 AND producto_id IS NOT NULL',
        [documentoId]
      );
      for (const i of viejos) {
        await client.query(
          'UPDATE productos SET existencias = existencias + $1 WHERE id = $2 AND controla_stock = true',
          [i.cantidad, i.producto_id]
        );
      }
    }
    await client.query('DELETE FROM documento_items WHERE documento_id = $1', [documentoId]);
    await client.query('DELETE FROM documento_pagos WHERE documento_id = $1', [documentoId]);

    // 2. Rehacer, igual que si se estuviera facturando de nuevo.
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
      return {
        producto_id: pid && costos.has(pid) ? pid : null,
        descripcion: String(i.descripcion || '').slice(0, 200) || 'Producto',
        detalle: i.detalle ? String(i.detalle).slice(0, 80) : null,
        cantidad,
        precio_unit: precio,
        costo_unit: pid && costos.has(pid) ? costos.get(pid) : 0,
        total: cantidad * precio,
      };
    });

    const tot = calcularTotales(preparados, cuerpo.descuento, cuerpo.iva);
    const costoTotal = preparados.reduce((acc, i) => acc + i.costo_unit * i.cantidad, 0);
    const margen = tot.subtotal - tot.descuento - costoTotal;

    const pagos = anterior.tipo === 'factura' && Array.isArray(cuerpo.pagos) ? cuerpo.pagos : [];
    const pagado = pagos.reduce((acc, p) => acc + (Number(p.valor) || 0), 0);
    const cambio = anterior.tipo === 'factura' ? Math.max(0, pagado - tot.total) : 0;

    await client.query(
      `UPDATE documentos SET cliente = $1, m2 = $2, subtotal = $3, descuento = $4, iva = $5, total = $6,
              costo_total = $7, margen = $8, cambio = $9,
              editado_en = now(), editado_por = $10, ediciones = ediciones + 1
       WHERE id = $11`,
      [
        String(cuerpo.cliente || '').slice(0, 160),
        cuerpo.m2 ? Number(cuerpo.m2) : null,
        tot.subtotal,
        tot.descuento,
        tot.iva,
        tot.total,
        costoTotal,
        margen,
        cambio,
        usuario.id,
        documentoId,
      ]
    );

    for (const i of preparados) {
      await client.query(
        `INSERT INTO documento_items (documento_id, producto_id, descripcion, detalle, cantidad, precio_unit, costo_unit, total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [documentoId, i.producto_id, i.descripcion, i.detalle, i.cantidad, i.precio_unit, i.costo_unit, i.total]
      );

      if (anterior.tipo === 'factura' && i.producto_id && stock.get(i.producto_id)?.controla_stock) {
        await client.query('UPDATE productos SET existencias = existencias - $1 WHERE id = $2', [
          i.cantidad,
          i.producto_id,
        ]);
        await client.query(
          `INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, documento_id, nota, registrado_por)
           VALUES ($1,'ajuste',$2,$3,$4,$5)`,
          [i.producto_id, -i.cantidad, documentoId, `Factura ${anterior.numero} editada`, usuario.id]
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
    return { id: documentoId, numero: anterior.numero };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

router.post('/facturar', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    if (req.body.documento_id) {
      const doc = await actualizarDocumento({
        documentoId: req.body.documento_id,
        almacenId: req.session.usuario.almacenId,
        usuario: req.session.usuario,
        cuerpo: req.body,
      });
      return res.json({ ok: true, id: doc.id, numero: doc.numero, imprimir: `/almacen/imprimir/${doc.id}` });
    }

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

  almacen.papel = papelEfectivo(req.session.usuario, almacen);

  res.render('almacen/cotizar', {
    almacen,
    papelNombre: NOMBRES_PAPEL[almacen.papel] || almacen.papel,
    productos: productos.rows,
    editando: null,
    materialesM2: MATERIALES_M2,
    activo: 'cotizar',
  });
});

router.post('/cotizar', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    if (req.body.documento_id) {
      const doc = await actualizarDocumento({
        documentoId: req.body.documento_id,
        almacenId: req.session.usuario.almacenId,
        usuario: req.session.usuario,
        cuerpo: req.body,
      });
      return res.json({ ok: true, id: doc.id, numero: doc.numero, imprimir: `/almacen/imprimir/${doc.id}` });
    }

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
    documentos: docs.rows.map((d) => ({ ...d, editable: !puedeEditar(d, req.session.usuario) })),
    metodos: (almacen.metodos_pago || 'Efectivo,Transferencia').split(',').map((m) => m.trim()).filter(Boolean),
    fecha,
    tipo,
    total,
    hoy: hoyISO(),
    activo: 'documentos',
    mensaje: req.query.ok || null,
    error: req.query.error || null,
  });
});

// Abrir una factura o cotización en la pantalla de venta, para corregirla.
router.get('/documentos/:id/editar', async (req, res) => {
  const almacenId = req.session.usuario.almacenId;
  const datos = await cargarDocumentoEditable(almacenId, req.params.id, req.session.usuario);
  if (datos.error) {
    return res.redirect('/almacen/documentos?error=' + encodeURIComponent(datos.error));
  }

  const { doc, items, pagos } = datos;
  const [almacen, productos] = await Promise.all([
    cargarAlmacen(almacenId),
    pool.query(
      `SELECT id, nombre, unidad, precio_venta, existencias, controla_stock
       FROM productos WHERE almacen_id = $1 AND activo = true ORDER BY nombre`,
      [almacenId]
    ),
  ]);
  almacen.papel = papelEfectivo(req.session.usuario, almacen);

  const editando = {
    id: doc.id,
    numero: doc.numero,
    tipo: doc.tipo,
    cliente: doc.cliente,
    descuento: Number(doc.descuento) || 0,
    iva: Number(doc.iva) > 0,
    m2: doc.m2 ? Number(doc.m2) : null,
    items: items.map((i) => ({
      producto_id: i.producto_id,
      descripcion: i.descripcion,
      detalle: i.detalle,
      cantidad: Number(i.cantidad),
      precio: Number(i.precio_unit),
    })),
    pagos: pagos.map((p) => ({ metodo: p.metodo, valor: Number(p.valor) })),
  };

  const comunes = {
    almacen,
    papelNombre: NOMBRES_PAPEL[almacen.papel] || almacen.papel,
    productos: productos.rows,
    editando,
    mensaje: null,
    error: null,
  };

  if (doc.tipo === 'cotizacion') {
    return res.render('almacen/cotizar', { ...comunes, materialesM2: MATERIALES_M2, activo: 'cotizar' });
  }
  res.render('almacen/facturar', {
    ...comunes,
    proximoNumero: doc.numero,
    ultima: { id: doc.id, numero: doc.numero },
    activo: 'facturar',
  });
});

// Cambiar solo la forma de pago: no toca inventario ni totales, solo cómo se pagó.
router.post('/documentos/:id/pagos', async (req, res) => {
  const almacenId = req.session.usuario.almacenId;
  const volver = `/almacen/documentos?fecha=${req.body.fecha || hoyISO()}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      "SELECT * FROM documentos WHERE id = $1 AND almacen_id = $2 AND tipo = 'factura' FOR UPDATE",
      [req.params.id, almacenId]
    );
    if (rows.length === 0) throw new Error('Factura no encontrada.');
    const doc = rows[0];
    const impedimento = puedeEditar(doc, req.session.usuario);
    if (impedimento) throw new Error(impedimento);

    // Llegan como metodo_1..n y valor_1..n; el valor vacío toma el total de la factura.
    const metodos = [];
    for (let i = 1; i <= 4; i++) {
      const metodo = String(req.body[`metodo_${i}`] || '').trim();
      const valor = Number(req.body[`valor_${i}`]);
      if (!metodo || !(valor > 0)) continue;
      metodos.push({ metodo: metodo.slice(0, 40), valor });
    }
    if (metodos.length === 0) throw new Error('Escribe al menos una forma de pago con su valor.');

    const pagado = metodos.reduce((a, p) => a + p.valor, 0);
    if (pagado + 0.01 < Number(doc.total)) {
      throw new Error(`Los pagos suman ${pagado.toLocaleString('es-CO')} y la factura es de ${Number(doc.total).toLocaleString('es-CO')}.`);
    }

    await client.query('DELETE FROM documento_pagos WHERE documento_id = $1', [doc.id]);
    for (const p of metodos) {
      await client.query('INSERT INTO documento_pagos (documento_id, metodo, valor) VALUES ($1,$2,$3)', [
        doc.id,
        p.metodo,
        p.valor,
      ]);
    }
    await client.query(
      'UPDATE documentos SET cambio = $1, editado_en = now(), editado_por = $2, ediciones = ediciones + 1 WHERE id = $3',
      [Math.max(0, pagado - Number(doc.total)), req.session.usuario.id, doc.id]
    );
    await client.query('COMMIT');
    res.redirect(volver + '&ok=' + encodeURIComponent(`Forma de pago de la factura ${doc.numero} actualizada.`));
  } catch (err) {
    await client.query('ROLLBACK');
    res.redirect(volver + '&error=' + encodeURIComponent(err.message));
  } finally {
    client.release();
  }
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
  const [almacen, productos] = await Promise.all([cargarAlmacen(almacenId), catalogoDe(almacenId)]);
  res.render('almacen/productos', {
    almacen,
    productos,
    activo: 'productos',
    mensaje: req.query.ok || null,
    error: req.query.error || null,
  });
});

montarCatalogo({
  prefijo: '/productos',
  destino: '/almacen/productos',
  lugar: 'el catálogo',
  conPrecio: true,
  almacenDe: (req) => req.session.usuario.almacenId,
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
  const usuarioId = req.session.usuario.id;
  const fecha = req.query.fecha || hoyISO();
  const [almacen, resumen, arqueo, movido] = await Promise.all([
    cargarAlmacen(almacenId),
    resumenCaja(almacenId, fecha),
    leerArqueo(pool, { almacenId, fecha, usuarioId }),
    efectivoDeLaCaja(pool, { almacenId, fecha, usuarioId }),
  ]);
  res.render('almacen/caja', {
    almacen,
    resumen,
    arqueo,
    movido,
    denominaciones: { billetes: BILLETES, monedas: MONEDAS },
    fecha,
    hoy: hoyISO(),
    activo: 'caja',
    mensaje: req.query.ok || null,
  });
});

// Contar el cajón. Se guarda sin recargar la pantalla; volver a guardar reemplaza el conteo.
router.post('/caja/arqueo', express.json(), async (req, res) => {
  const almacenId = req.session.usuario.almacenId;
  const usuarioId = req.session.usuario.id;
  const fecha = (req.body.fecha || hoyISO()).slice(0, 10);
  const destino = '/almacen/caja?fecha=' + fecha;
  try {
    const arqueo = await guardarArqueo(pool, {
      almacenId,
      fecha,
      usuarioId,
      detalle: req.body.detalle || {},
      base: req.body.base,
      nota: req.body.nota,
    });
    responder(req, res, {
      destino,
      ok: 'Conteo guardado.',
      json: { arqueo, mensaje: 'Conteo guardado.' },
    });
  } catch (err) {
    responder(req, res, { destino, error: 'No se pudo guardar el conteo: ' + err.message });
  }
});

router.post('/caja/arqueo/borrar', express.json(), async (req, res) => {
  const fecha = (req.body.fecha || hoyISO()).slice(0, 10);
  await borrarArqueo(pool, {
    almacenId: req.session.usuario.almacenId,
    fecha,
    usuarioId: req.session.usuario.id,
  });
  responder(req, res, {
    destino: '/almacen/caja?fecha=' + fecha,
    ok: 'Conteo borrado.',
    json: { mensaje: 'Conteo borrado.' },
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

// ============================ VENTAS EN ESPERA ============================
// Un cliente que no se decide no puede bloquear la caja. La venta a medio hacer se guarda
// «en espera» y el vendedor atiende al siguiente; después la retoma donde iba.
// Ojo: NO es una factura. No tiene número, no descuenta inventario y no aparece en reportes;
// la mercancía sigue disponible para quien la compre primero.

const MAX_ESPERA = 30;

function tipoBorrador(valor) {
  return valor === 'cotizacion' ? 'cotizacion' : 'factura';
}

router.get('/borradores', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.id, b.nombre, b.total, b.lineas, b.actualizado_en, u.nombre AS vendedor
     FROM borradores b LEFT JOIN usuarios u ON u.id = b.registrado_por
     WHERE b.almacen_id = $1 AND b.tipo = $2
     ORDER BY b.actualizado_en DESC LIMIT $3`,
    [req.session.usuario.almacenId, tipoBorrador(req.query.tipo), MAX_ESPERA]
  );
  res.json({ ok: true, borradores: rows });
});

router.post('/borradores', express.json({ limit: '256kb' }), async (req, res) => {
  const almacenId = req.session.usuario.almacenId;
  const tipo = tipoBorrador(req.body.tipo);

  try {
    // Una venta en espera de hace un mes ya no la reclama nadie: se limpia sola.
    await pool.query(
      "DELETE FROM borradores WHERE almacen_id = $1 AND actualizado_en < now() - INTERVAL '30 days'",
      [almacenId]
    );

    const { rows: cuenta } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM borradores WHERE almacen_id = $1 AND tipo = $2',
      [almacenId, tipo]
    );
    if (cuenta[0].n >= MAX_ESPERA) {
      throw new Error(`Ya hay ${MAX_ESPERA} en espera. Cierra o borra alguna antes de guardar otra.`);
    }

    const { rows } = await pool.query(
      `INSERT INTO borradores (almacen_id, tipo, nombre, datos, total, lineas, registrado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        almacenId,
        tipo,
        String(req.body.nombre || '').slice(0, 120) || 'Sin nombre',
        req.body.datos || {},
        Number(req.body.total) || 0,
        Number(req.body.lineas) || 0,
        req.session.usuario.id,
      ]
    );
    res.json({ ok: true, id: rows[0].id });
  } catch (err) {
    console.error('Error guardando en espera:', err);
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Retomar: devuelve el contenido y lo saca de la lista (pasa a ser la venta abierta).
router.post('/borradores/:id/abrir', async (req, res) => {
  const { rows } = await pool.query('DELETE FROM borradores WHERE id = $1 AND almacen_id = $2 RETURNING *', [
    req.params.id,
    req.session.usuario.almacenId,
  ]);
  if (rows.length === 0) return res.status(404).json({ ok: false, error: 'Esa venta en espera ya no está.' });
  res.json({ ok: true, borrador: rows[0] });
});

router.post('/borradores/:id/eliminar', async (req, res) => {
  await pool.query('DELETE FROM borradores WHERE id = $1 AND almacen_id = $2', [
    req.params.id,
    req.session.usuario.almacenId,
  ]);
  res.json({ ok: true });
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

// ============================ BODEGA ============================
// Una bodega es un almacén que NO vende: solo guarda mercancía y la despacha a los demás.
// La maneja el almacén al que está enlazada (`bodega_de`), así que su gente entra desde
// su propia sesión, sin un usuario aparte. El costo y el valor de la mercancía NO se ven
// aquí: eso lo ve la administración en su panel, como con todo lo demás.

async function bodegaDe(almacenId) {
  const { rows } = await pool.query(
    'SELECT * FROM almacenes WHERE bodega_de = $1 AND es_bodega = true AND activo = true ORDER BY id LIMIT 1',
    [almacenId]
  );
  return rows[0] || null;
}

// Todas las rutas de /bodega necesitan lo mismo: que exista y que sea la de esta caja.
async function conBodega(req, res, next) {
  const bodega = await bodegaDe(req.session.usuario.almacenId);
  if (!bodega) {
    return res.redirect('/almacen?error=' + encodeURIComponent('Este almacén no tiene bodega enlazada.'));
  }
  req.bodega = bodega;
  next();
}

router.get('/bodega', conBodega, async (req, res) => {
  res.render('almacen/bodega', {
    almacen: await cargarAlmacen(req.session.usuario.almacenId),
    bodega: req.bodega,
    productos: await catalogoDe(req.bodega.id),
    activo: 'bodega',
    mensaje: req.query.ok || null,
    error: req.query.error || null,
  });
});

// La bodega usa el mismo catálogo que el almacén, pero sin precio de venta: no vende.
montarCatalogo({
  prefijo: '/bodega/productos',
  destino: '/almacen/bodega',
  lugar: 'la bodega',
  conPrecio: false,
  almacenDe: (req) => req.bodega.id,
  previos: [conBodega],
});

router.get('/bodega/excel', conBodega, async (req, res) => {
  const productos = await pool.query(
    `SELECT nombre, unidad, precio_venta, existencias, controla_stock
     FROM productos WHERE almacen_id = $1 AND activo = true ORDER BY nombre`,
    [req.bodega.id]
  );
  const archivo = `inventario_${req.bodega.nombre.replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${archivo}"`);
  res.send(inventarioExcel(productos.rows, { conCosto: false }));
});

router.post('/bodega/importar', conBodega, subida.single('archivo'), async (req, res) => {
  if (!req.file) return res.redirect('/almacen/bodega?error=' + encodeURIComponent('Elige el archivo de Excel.'));

  let revision;
  try {
    revision = await revisarInventario(pool, req.bodega.id, req.file.buffer);
  } catch (err) {
    return res.redirect('/almacen/bodega?error=' + encodeURIComponent('No pude leer el archivo.'));
  }
  if (revision.filas.length === 0) {
    return res.redirect(
      '/almacen/bodega?error=' + encodeURIComponent(revision.errores[0] || 'El archivo no tiene productos.')
    );
  }

  res.render('almacen/importar', {
    almacen: req.bodega,
    destino: 'bodega',
    previo: {
      ...revision,
      modoExistencias: req.body.modo_existencias === 'sumar' ? 'sumar' : 'reemplazar',
      nombreArchivo: req.file.originalname,
      filasFormulario: filasParaFormulario(revision.filas, false),
    },
    activo: 'bodega',
  });
});

router.post('/bodega/importar/aplicar', conBodega, async (req, res) => {
  let filas;
  try {
    filas = JSON.parse(req.body.filas || '[]');
  } catch (err) {
    return res.redirect('/almacen/bodega?error=' + encodeURIComponent('Se perdió la vista previa.'));
  }
  try {
    const { creados, actualizados } = await aplicarInventario(pool, {
      almacenId: req.bodega.id,
      filas,
      modo: req.body.modo_existencias,
      conCosto: false,
    });
    res.redirect(
      '/almacen/bodega?ok=' + encodeURIComponent(`Listo: ${creados} nuevo(s) y ${actualizados} actualizado(s).`)
    );
  } catch (err) {
    res.redirect('/almacen/bodega?error=' + encodeURIComponent('No se pudo guardar: ' + err.message));
  }
});

// Despachar desde la bodega: la misma hoja de traslado, pero el origen es la bodega.
router.get('/bodega/traslados', conBodega, async (req, res) => {
  const [almacen, destinos, productos, historial] = await Promise.all([
    cargarAlmacen(req.session.usuario.almacenId),
    pool.query('SELECT id, nombre FROM almacenes WHERE activo = true AND id <> $1 ORDER BY nombre', [req.bodega.id]),
    pool.query(
      `SELECT id, nombre, unidad, existencias, controla_stock
       FROM productos WHERE almacen_id = $1 AND activo = true ORDER BY nombre`,
      [req.bodega.id]
    ),
    listarTraslados(pool, { almacenId: req.bodega.id, limite: 60 }),
  ]);

  res.render('almacen/bodega_traslados', {
    almacen,
    bodega: req.bodega,
    destinos: destinos.rows,
    productos: productos.rows,
    historial,
    hoy: hoyISO(),
    activo: 'bodega',
    mensaje: req.query.ok || null,
    error: req.query.error || null,
  });
});

router.post('/bodega/traslados', conBodega, express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const t = await crearTraslado(pool, {
      origenId: req.bodega.id,
      destinoId: req.body.destino_id,
      usuarioId: req.session.usuario.id,
      cuerpo: req.body,
    });
    res.json({ ok: true, id: t.id, numero: t.numero, imprimir: `/almacen/traslados/imprimir/${t.id}` });
  } catch (err) {
    console.error('Error al despachar de la bodega:', err);
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/bodega/traslados/:id/anular', conBodega, async (req, res) => {
  try {
    await anularTraslado(pool, {
      trasladoId: req.params.id,
      almacenId: req.bodega.id,
      usuarioId: req.session.usuario.id,
    });
    res.redirect('/almacen/bodega/traslados?ok=' + encodeURIComponent('Traslado anulado; la mercancía volvió a la bodega.'));
  } catch (err) {
    res.redirect('/almacen/bodega/traslados?error=' + encodeURIComponent(err.message));
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
    papelCss: papelCss(papelEfectivo(req.session.usuario, almacen)),
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
  const bodega = await bodegaDe(almacenId);
  const datos = await cargarTraslado(pool, req.params.id, bodega ? [almacenId, bodega.id] : almacenId);
  if (!datos) return res.status(404).render('404');

  const almacen = await cargarAlmacen(almacenId);
  res.render('imprimir_traslado', {
    almacen,
    traslado: datos.traslado,
    items: datos.items,
    papelCss: papelCss(papelEfectivo(req.session.usuario, almacen)),
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
  // Cada caja puede tener su propia impresora y su propio papel.
  const papel = papelEfectivo(req.session.usuario, almacen);

  res.render('imprimir', {
    almacen,
    doc,
    items,
    pagos,
    papel,
    papelNombre: NOMBRES_PAPEL[papel] || papel,
    densidad: densidadFactura(items.length),
    altoMaximo: ALTO_MAXIMO[papel] || ALTO_MAXIMO.carta,
    papelCss: papelCss(papel),
    hora: horaTexto(doc.creado_en),
    fechaTexto: fechaTexto(doc.fecha),
    volver: doc.tipo === 'factura' ? '/almacen' : '/almacen/cotizar',
    auto: req.query.auto !== '0',
  });
});

router.get('/caja/imprimir', async (req, res) => {
  const almacenId = req.session.usuario.almacenId;
  const fecha = req.query.fecha || hoyISO();
  const [almacen, resumen, arqueo] = await Promise.all([
    cargarAlmacen(almacenId),
    resumenCaja(almacenId, fecha),
    leerArqueo(pool, { almacenId, fecha, usuarioId: req.session.usuario.id }),
  ]);
  const papel = papelEfectivo(req.session.usuario, almacen);
  res.render('imprimir_cierre', {
    almacen,
    resumen,
    arqueo,
    fecha,
    papel,
    // En media carta y carta el cierre también tiene que caber en UNA hoja.
    altoMaximo: ALTO_MAXIMO[papel] || 0,
    papelCss: papelCss(papel),
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
