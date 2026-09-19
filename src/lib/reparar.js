// Reparaciones de datos que solo puede hacer la administración.
//
// Por qué existe esto: el costo se guarda como una "foto" dentro de cada factura
// (documento_items.costo_unit). Eso está bien para el día a día —cambiar el costo hoy no
// debe alterar lo que se vendió el mes pasado— pero deja dos situaciones sin salida:
//
//   1. El archivo de Excel venía con las columnas de venta y costo al revés, así que las
//      facturas ya hechas guardaron un costo mayor que el precio de venta y la ganancia
//      sale negativa.
//   2. Se cargaron productos sin precio de costo (costo 0) y se vendieron así; al ponerles
//      el costo después, esas facturas siguen calculando como si el material fuera gratis.
//
// Las dos se arreglan volviendo a tomar el costo del catálogo y recalculando las facturas.
//
// Todo corre dentro de una transacción. Para la vista previa se hace exactamente el mismo
// trabajo y al final se hace ROLLBACK: lo que se muestra es, literalmente, lo que va a pasar.

const RESUMEN = `
  SELECT COUNT(*)::int AS facturas,
         COALESCE(SUM(total),0)       AS venta,
         COALESCE(SUM(costo_total),0) AS costo,
         COALESCE(SUM(margen),0)      AS margen,
         COUNT(*) FILTER (WHERE margen < 0)::int AS negativas
  FROM documentos
  WHERE tipo = 'factura' AND anulada = false`;

// `tabla` es el alias con el que se nombran las columnas en cada consulta ('' , 'd.' o 'p.').
function filtros(almacenId, desde, tabla = '') {
  const cond = [];
  const params = [];
  if (almacenId) {
    params.push(almacenId);
    cond.push(`${tabla}almacen_id = $${params.length}`);
  }
  if (desde) {
    params.push(desde);
    cond.push(`${tabla}fecha >= $${params.length}::date`);
  }
  return { sql: cond.length ? ' AND ' + cond.join(' AND ') : '', params };
}

async function resumen(client, almacenId, desde) {
  const { sql, params } = filtros(almacenId, desde);
  const { rows } = await client.query(RESUMEN + sql, params);
  return {
    facturas: rows[0].facturas,
    venta: Number(rows[0].venta),
    costo: Number(rows[0].costo),
    margen: Number(rows[0].margen),
    negativas: rows[0].negativas,
  };
}

// Productos sospechosos de tener las dos columnas al revés: lo que dice "costo" es mayor
// que lo que dice "venta". Un producto que de verdad se venda por debajo del costo es raro,
// por eso se muestran uno por uno y se elige cuáles cambiar.
async function detectarInvertidos(client, almacenId) {
  const { sql, params } = filtros(almacenId, null, 'p.');
  const { rows } = await client.query(
    `SELECT p.id, p.nombre, p.unidad, p.precio_venta, p.precio_costo, p.existencias,
            a.nombre AS almacen_nombre
     FROM productos p JOIN almacenes a ON a.id = p.almacen_id
     WHERE p.activo = true AND p.precio_costo > p.precio_venta AND p.precio_venta > 0
           ${sql}
     ORDER BY a.nombre, p.nombre`,
    params
  );
  return rows.map((p) => ({
    ...p,
    precio_venta: Number(p.precio_venta),
    precio_costo: Number(p.precio_costo),
  }));
}

// Vuelve a tomar el costo del catálogo para cada línea de factura y recalcula el documento.
// Las líneas cuyo producto ya no existe se dejan como están (no hay de dónde sacar el costo).
async function recalcularFacturas(client, almacenId, desde) {
  const { sql, params } = filtros(almacenId, desde, 'd.');

  const items = await client.query(
    `UPDATE documento_items i
        SET costo_unit = p.precio_costo
       FROM productos p, documentos d
      WHERE i.producto_id = p.id
        AND d.id = i.documento_id
        AND d.tipo = 'factura'
        AND i.costo_unit IS DISTINCT FROM p.precio_costo
        ${sql}`,
    params
  );

  const docs = await client.query(
    `UPDATE documentos d
        SET costo_total = s.costo,
            margen      = (d.subtotal - d.descuento) - s.costo
       FROM (SELECT documento_id, COALESCE(SUM(costo_unit * cantidad),0) AS costo
               FROM documento_items GROUP BY documento_id) s
      WHERE s.documento_id = d.id
        AND d.tipo = 'factura'
        AND (d.costo_total IS DISTINCT FROM s.costo
             OR d.margen IS DISTINCT FROM (d.subtotal - d.descuento) - s.costo)
        ${sql}`,
    params
  );

  return { lineas: items.rowCount, documentos: docs.rowCount };
}

// Motor común: hace el trabajo de verdad y decide al final si lo guarda o lo deshace.
async function ejecutar(pool, { almacenId, desde, aplicar }, trabajo) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const antes = await resumen(client, almacenId, desde);
    const detalle = await trabajo(client);
    const tocado = await recalcularFacturas(client, almacenId, desde);
    const despues = await resumen(client, almacenId, desde);

    if (aplicar) await client.query('COMMIT');
    else await client.query('ROLLBACK');

    return { aplicado: Boolean(aplicar), antes, despues, ...tocado, ...detalle };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// 1) Intercambiar venta y costo en los productos elegidos y recalcular sus facturas.
async function repararInvertidos(pool, { almacenId, ids, desde, aplicar }) {
  const limpios = (ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (limpios.length === 0) throw new Error('No elegiste ningún producto.');

  return ejecutar(pool, { almacenId, desde, aplicar }, async (client) => {
    const { rows } = await client.query(
      `UPDATE productos
          SET precio_venta = precio_costo,
              precio_costo = precio_venta,
              actualizado_en = now()
        WHERE id = ANY($1::int[])
          AND ($2::int IS NULL OR almacen_id = $2)
        RETURNING id, nombre, precio_venta, precio_costo`,
      [limpios, almacenId || null]
    );
    return { productos: rows, cambiados: rows.length };
  });
}

// 2) Solo recalcular: útil cuando el costo se puso después de haber vendido.
async function repararCostos(pool, { almacenId, desde, aplicar }) {
  return ejecutar(pool, { almacenId, desde, aplicar }, async () => ({ productos: [], cambiados: 0 }));
}

module.exports = { detectarInvertidos, repararInvertidos, repararCostos, resumen };
