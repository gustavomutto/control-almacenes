// «Movimiento del día» de un almacén: qué material salió hoy y por dónde.
//
// Responde la pregunta del mostrador: ¿cuánto material vendí hoy y cuánto me queda?
// Se mide en unidades, no solo en plata, y separa lo que salió vendido de lo que salió
// trasladado a otro almacén (que no es una venta) y de lo que entró.
//
// Ojo: esta pantalla la ve el personal del almacén, así que aquí NO va el costo ni la ganancia.

async function movimientoDelDia(pool, almacenId, fecha) {
  const [vendido, entradas, enviados, recibidos, facturas] = await Promise.all([
    pool.query(
      `SELECT i.descripcion AS material,
              COALESCE(MAX(p.unidad), 'unidad') AS unidad,
              SUM(i.cantidad) AS cantidad,
              SUM(i.total)    AS total
       FROM documento_items i
       JOIN documentos d ON d.id = i.documento_id
       LEFT JOIN productos p ON p.id = i.producto_id
       WHERE d.almacen_id = $1 AND d.fecha = $2 AND d.tipo = 'factura' AND d.anulada = false
       GROUP BY i.descripcion
       ORDER BY SUM(i.total) DESC, i.descripcion`,
      [almacenId, fecha]
    ),
    pool.query(
      `SELECT p.nombre AS material, p.unidad, SUM(m.cantidad) AS cantidad
       FROM movimientos_inventario m
       JOIN productos p ON p.id = m.producto_id
       WHERE p.almacen_id = $1 AND m.tipo IN ('entrada','ajuste') AND m.creado_en::date = $2::date
       GROUP BY p.nombre, p.unidad
       HAVING SUM(m.cantidad) <> 0
       ORDER BY p.nombre`,
      [almacenId, fecha]
    ),
    pool.query(
      `SELECT i.descripcion AS material, i.unidad, SUM(i.cantidad) AS cantidad,
              string_agg(DISTINCT a.nombre, ', ') AS otro_almacen
       FROM traslado_items i
       JOIN traslados t ON t.id = i.traslado_id
       JOIN almacenes a ON a.id = t.destino_id
       WHERE t.origen_id = $1 AND t.fecha = $2 AND t.anulado = false
       GROUP BY i.descripcion, i.unidad
       ORDER BY i.descripcion`,
      [almacenId, fecha]
    ),
    pool.query(
      `SELECT i.descripcion AS material, i.unidad, SUM(i.cantidad) AS cantidad,
              string_agg(DISTINCT a.nombre, ', ') AS otro_almacen
       FROM traslado_items i
       JOIN traslados t ON t.id = i.traslado_id
       JOIN almacenes a ON a.id = t.origen_id
       WHERE t.destino_id = $1 AND t.fecha = $2 AND t.anulado = false
       GROUP BY i.descripcion, i.unidad
       ORDER BY i.descripcion`,
      [almacenId, fecha]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS cantidad, COALESCE(SUM(total),0) AS total
       FROM documentos WHERE almacen_id = $1 AND fecha = $2 AND tipo = 'factura' AND anulada = false`,
      [almacenId, fecha]
    ),
  ]);

  const aNumeros = (filas) =>
    filas.map((f) => ({ ...f, cantidad: Number(f.cantidad), total: f.total === undefined ? null : Number(f.total) }));

  const lineasVendido = aNumeros(vendido.rows);

  return {
    vendido: lineasVendido,
    entradas: aNumeros(entradas.rows),
    enviados: aNumeros(enviados.rows),
    recibidos: aNumeros(recibidos.rows),
    totales: {
      facturas: facturas.rows[0].cantidad,
      venta: Number(facturas.rows[0].total),
      materiales: lineasVendido.length,
      unidades: lineasVendido.reduce((a, l) => a + l.cantidad, 0),
      unidadesEnviadas: enviados.rows.reduce((a, l) => a + Number(l.cantidad), 0),
      unidadesRecibidas: recibidos.rows.reduce((a, l) => a + Number(l.cantidad), 0),
    },
  };
}

// Registro de los últimos días: cuántas unidades y cuánta plata cada día, para tener
// la historia a la mano sin ir día por día.
async function ultimosDias(pool, almacenId, dias = 15) {
  const { rows } = await pool.query(
    `SELECT d.fecha,
            COUNT(DISTINCT d.id)::int AS facturas,
            COALESCE(SUM(i.cantidad),0) AS unidades,
            COALESCE(SUM(i.total),0)    AS venta
     FROM documentos d
     JOIN documento_items i ON i.documento_id = d.id
     WHERE d.almacen_id = $1 AND d.tipo = 'factura' AND d.anulada = false
           AND d.fecha > CURRENT_DATE - $2::int
     GROUP BY d.fecha
     ORDER BY d.fecha DESC`,
    [almacenId, dias]
  );
  return rows.map((r) => ({ ...r, unidades: Number(r.unidades), venta: Number(r.venta) }));
}

// El mismo detalle del día, en Excel, para quien lo quiera guardar o mandar por WhatsApp.
function movimientoExcel(movimiento, { almacenNombre, fecha }) {
  const XLSX = require('xlsx');
  const filas = movimiento.vendido.map((l) => ({
    material: l.material,
    cantidad: l.cantidad,
    unidad: l.unidad,
    vendido: l.total,
  }));
  movimiento.enviados.forEach((l) => {
    filas.push({ material: l.material, cantidad: l.cantidad, unidad: l.unidad, vendido: 'TRASLADO a ' + l.otro_almacen });
  });

  const hoja = XLSX.utils.json_to_sheet(
    filas.length > 0 ? filas : [{ material: 'Sin movimiento', cantidad: 0, unidad: '', vendido: 0 }]
  );
  hoja['!cols'] = [{ wch: 36 }, { wch: 12 }, { wch: 12 }, { wch: 22 }];
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, hoja, `${fecha}`.slice(0, 28));
  libro.Props = { Title: `Material vendido ${almacenNombre} ${fecha}` };
  return XLSX.write(libro, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { movimientoDelDia, ultimosDias, movimientoExcel };
