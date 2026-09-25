// Traslados de mercancía entre almacenes.
//
// Un traslado NO es una venta: no lleva precio, no entra a la caja y no afecta la ganancia.
// (Facturar a cero pesos sería peor: el almacén que envía quedaría con el costo de esa
// mercancía como pérdida y el que recibe con ganancia inflada.)
//
// Lo que sí hace: descontar del inventario de origen, sumarlo al de destino y dejar la hoja
// firmada para quien lleva la mercancía. El precio de costo viaja con el producto, así que
// cuando el almacén de destino venda, la ganancia le sale bien sin que nadie toque nada.

const { hoyISO } = require('./fecha');

async function siguienteNumero(client, origenId) {
  // Bloquea el almacén para que dos traslados simultáneos no tomen el mismo consecutivo.
  await client.query('SELECT id FROM almacenes WHERE id = $1 FOR UPDATE', [origenId]);
  const { rows } = await client.query('SELECT COALESCE(MAX(numero),0) + 1 AS n FROM traslados WHERE origen_id = $1', [
    origenId,
  ]);
  return rows[0].n;
}

async function crearTraslado(pool, { origenId, destinoId, usuarioId, cuerpo }) {
  const origen = Number(origenId);
  const destino = Number(destinoId || cuerpo.destino_id);
  const items = Array.isArray(cuerpo.items) ? cuerpo.items : [];

  if (!origen || !destino) throw new Error('Falta el almacén que envía o el que recibe.');
  if (origen === destino) throw new Error('El almacén que envía y el que recibe no pueden ser el mismo.');
  if (items.length === 0) throw new Error('No hay productos en el traslado.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: almacenes } = await client.query(
      'SELECT id, nombre, activo FROM almacenes WHERE id = ANY($1::int[])',
      [[origen, destino]]
    );
    if (almacenes.length !== 2) throw new Error('Alguno de los almacenes no existe.');

    const numero = await siguienteNumero(client, origen);

    // Se piden los productos del almacén de origen para validar cantidades y tomar el costo.
    const ids = items.map((i) => Number(i.producto_id)).filter((n) => Number.isInteger(n) && n > 0);
    const { rows: productos } = await client.query(
      'SELECT id, nombre, unidad, precio_venta, precio_costo, existencias, controla_stock FROM productos WHERE almacen_id = $1 AND id = ANY($2::int[])',
      [origen, ids]
    );
    const porId = new Map(productos.map((p) => [p.id, p]));

    const preparados = [];
    for (const i of items) {
      const p = porId.get(Number(i.producto_id));
      if (!p) throw new Error('Un producto de la lista ya no está en el inventario de este almacén.');

      const cantidad = Number(i.cantidad) || 0;
      if (cantidad <= 0) throw new Error(`La cantidad de «${p.nombre}» debe ser mayor que cero.`);
      if (p.controla_stock && Number(p.existencias) < cantidad) {
        throw new Error(
          `No hay suficiente «${p.nombre}»: quedan ${Number(p.existencias)} ${p.unidad} y estás enviando ${cantidad}.`
        );
      }
      preparados.push({ producto: p, cantidad });
    }

    const { rows: cabecera } = await client.query(
      `INSERT INTO traslados (numero, origen_id, destino_id, fecha, responsable, nota, registrado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        numero,
        origen,
        destino,
        cuerpo.fecha || hoyISO(),
        String(cuerpo.responsable || '').slice(0, 120),
        String(cuerpo.nota || '').slice(0, 300),
        usuarioId,
      ]
    );
    const trasladoId = cabecera[0].id;

    for (const { producto, cantidad } of preparados) {
      // Sale de origen.
      if (producto.controla_stock) {
        await client.query('UPDATE productos SET existencias = existencias - $1 WHERE id = $2', [
          cantidad,
          producto.id,
        ]);
        await client.query(
          `INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, traslado_id, nota, registrado_por)
           VALUES ($1,'traslado',$2,$3,$4,$5)`,
          [producto.id, -cantidad, trasladoId, `Traslado ${numero} enviado`, usuarioId]
        );
      }

      // Entra a destino. Si el producto no existe allá, se crea con el mismo nombre, unidad y
      // costo; si ya existe, solo se le suma la cantidad y se le completa el costo si estaba en 0.
      const { rows: destinoProducto } = await client.query(
        `INSERT INTO productos (almacen_id, nombre, unidad, precio_venta, precio_costo, existencias, controla_stock)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (almacen_id, nombre) DO UPDATE SET
           existencias = productos.existencias + EXCLUDED.existencias,
           precio_costo = CASE WHEN productos.precio_costo = 0 THEN EXCLUDED.precio_costo ELSE productos.precio_costo END,
           precio_venta = CASE WHEN productos.precio_venta = 0 THEN EXCLUDED.precio_venta ELSE productos.precio_venta END,
           activo = true,
           actualizado_en = now()
         RETURNING id`,
        [
          destino,
          producto.nombre,
          producto.unidad,
          producto.precio_venta,
          producto.precio_costo,
          cantidad,
          producto.controla_stock,
        ]
      );

      await client.query(
        `INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, traslado_id, nota, registrado_por)
         VALUES ($1,'traslado',$2,$3,$4,$5)`,
        [destinoProducto[0].id, cantidad, trasladoId, `Traslado ${numero} recibido`, usuarioId]
      );

      await client.query(
        `INSERT INTO traslado_items (traslado_id, producto_id, destino_producto_id, descripcion, unidad, cantidad, costo_unit)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          trasladoId,
          producto.id,
          destinoProducto[0].id,
          producto.nombre,
          producto.unidad,
          cantidad,
          producto.precio_costo,
        ]
      );
    }

    await client.query('COMMIT');
    return { id: trasladoId, numero };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Anular devuelve la mercancía a donde estaba. Se bloquea si el almacén de destino ya la vendió
// y quedaría en negativo, porque eso sería tapar un hueco con otro.
async function anularTraslado(pool, { trasladoId, almacenId, usuarioId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query('SELECT * FROM traslados WHERE id = $1 AND anulado = false', [trasladoId]);
    if (rows.length === 0) throw new Error('Traslado no encontrado o ya anulado.');
    const t = rows[0];
    if (almacenId && Number(almacenId) !== t.origen_id) {
      throw new Error('Solo el almacén que envió la mercancía puede anular el traslado.');
    }

    const { rows: items } = await client.query('SELECT * FROM traslado_items WHERE traslado_id = $1', [trasladoId]);

    for (const i of items) {
      if (i.destino_producto_id) {
        const { rows: dest } = await client.query(
          'SELECT nombre, existencias, controla_stock FROM productos WHERE id = $1',
          [i.destino_producto_id]
        );
        if (dest.length > 0 && dest[0].controla_stock && Number(dest[0].existencias) < Number(i.cantidad)) {
          throw new Error(
            `No se puede anular: en el almacén de destino ya solo quedan ${Number(dest[0].existencias)} de ` +
              `«${dest[0].nombre}» y el traslado movió ${Number(i.cantidad)}.`
          );
        }
        await client.query(
          'UPDATE productos SET existencias = existencias - $1 WHERE id = $2 AND controla_stock = true',
          [i.cantidad, i.destino_producto_id]
        );
        await client.query(
          `INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, traslado_id, nota, registrado_por)
           VALUES ($1,'anulacion',$2,$3,$4,$5)`,
          [i.destino_producto_id, -i.cantidad, trasladoId, `Traslado ${t.numero} anulado`, usuarioId]
        );
      }
      if (i.producto_id) {
        await client.query(
          'UPDATE productos SET existencias = existencias + $1 WHERE id = $2 AND controla_stock = true',
          [i.cantidad, i.producto_id]
        );
        await client.query(
          `INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, traslado_id, nota, registrado_por)
           VALUES ($1,'anulacion',$2,$3,$4,$5)`,
          [i.producto_id, i.cantidad, trasladoId, `Traslado ${t.numero} anulado`, usuarioId]
        );
      }
    }

    await client.query('UPDATE traslados SET anulado = true WHERE id = $1', [trasladoId]);
    await client.query('COMMIT');
    return t;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const SQL_TRASLADO = `
  SELECT t.*, o.nombre AS origen_nombre, d.nombre AS destino_nombre, u.nombre AS registrado_nombre
  FROM traslados t
  JOIN almacenes o ON o.id = t.origen_id
  JOIN almacenes d ON d.id = t.destino_id
  LEFT JOIN usuarios u ON u.id = t.registrado_por`;

// Un traslado lo puede ver (e imprimir) el almacén que envía y el que recibe.
async function cargarTraslado(pool, id, almacenId) {
  const { rows } = await pool.query(
    `${SQL_TRASLADO} WHERE t.id = $1 ${almacenId ? 'AND (t.origen_id = $2 OR t.destino_id = $2)' : ''}`,
    almacenId ? [id, almacenId] : [id]
  );
  if (rows.length === 0) return null;

  const { rows: items } = await pool.query(
    'SELECT * FROM traslado_items WHERE traslado_id = $1 ORDER BY id',
    [id]
  );
  return { traslado: rows[0], items };
}

async function listarTraslados(pool, { almacenId, desde, hasta, limite = 100 }) {
  const cond = [];
  const params = [];
  if (almacenId) {
    params.push(almacenId);
    cond.push(`(t.origen_id = $${params.length} OR t.destino_id = $${params.length})`);
  }
  if (desde) {
    params.push(desde);
    cond.push(`t.fecha >= $${params.length}::date`);
  }
  if (hasta) {
    params.push(hasta);
    cond.push(`t.fecha <= $${params.length}::date`);
  }
  params.push(limite);

  const { rows } = await pool.query(
    `${SQL_TRASLADO}
     ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
     ORDER BY t.fecha DESC, t.id DESC LIMIT $${params.length}`,
    params
  );

  if (rows.length === 0) return [];

  // Resumen de cada hoja: cuántos productos y cuántas unidades lleva.
  const { rows: resumen } = await pool.query(
    `SELECT traslado_id, COUNT(*)::int AS lineas, COALESCE(SUM(cantidad),0) AS unidades
     FROM traslado_items WHERE traslado_id = ANY($1::int[]) GROUP BY traslado_id`,
    [rows.map((r) => r.id)]
  );
  const porId = new Map(resumen.map((r) => [r.traslado_id, r]));

  return rows.map((t) => ({
    ...t,
    lineas: porId.get(t.id)?.lineas || 0,
    unidades: Number(porId.get(t.id)?.unidades || 0),
  }));
}

module.exports = { crearTraslado, anularTraslado, cargarTraslado, listarTraslados };
