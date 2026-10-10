/* Cajas de todos los almacenes, para administración.
   Responde lo mismo que el cierre de caja de cada almacén —venta, efectivo, transferencia
   y «efectivo a entregar»— pero de todos los almacenes a la vez y, dentro de cada uno,
   caja por caja (cada usuario que factura es una caja).

   «Efectivo a entregar» = efectivo cobrado − gastos pagados de ese efectivo. Es la misma
   cuenta que ve el almacén en su pantalla de caja, así que los números coinciden. */

// Cada almacén escribe sus formas de pago a mano («Efectivo,Transferencia,Datáfono»), así que
// se clasifican por lo que dice el nombre y lo que no se reconoce entra en «otros».
function tipoDePago(metodo) {
  const t = String(metodo || '').toLowerCase();
  if (t.includes('efectiv')) return 'efectivo';
  if (t.includes('transfer')) return 'transferencia';
  return 'otros';
}

function vacio() {
  return {
    venta: 0,
    facturas: 0,
    efectivo: 0,
    transferencia: 0,
    otros: 0,
    gastos: 0,
    entregar: 0,
    // Conteo físico del cajón, cuando la caja lo hizo (ver lib/arqueo.js).
    arqueos: 0,
    contado: 0,
    diferencia: 0,
  };
}

function acumular(destino, origen) {
  for (const k of ['venta', 'facturas', 'efectivo', 'transferencia', 'otros', 'gastos', 'arqueos', 'contado', 'diferencia']) {
    destino[k] += origen[k];
  }
  destino.entregar = destino.efectivo - destino.gastos;
  return destino;
}

async function resumenCajas(pool, { desde, hasta }) {
  const rango = [desde, hasta];

  const [almacenes, usuarios, ventas, pagos, gastos, arqueos] = await Promise.all([
    pool.query(
      `SELECT a.id, a.nombre, r.nombre AS region_nombre
         FROM almacenes a LEFT JOIN regiones r ON r.id = a.region_id
        WHERE a.activo = true AND a.es_bodega = false
        ORDER BY r.nombre NULLS LAST, a.nombre`
    ),
    pool.query(
      `SELECT id, nombre, usuario, almacen_id, rol, activo FROM usuarios ORDER BY nombre`
    ),
    pool.query(
      `SELECT almacen_id, registrado_por, COALESCE(SUM(total),0) AS venta, COUNT(*) AS facturas
         FROM documentos
        WHERE tipo = 'factura' AND anulada = false AND fecha BETWEEN $1 AND $2
        GROUP BY almacen_id, registrado_por`,
      rango
    ),
    pool.query(
      `SELECT d.almacen_id, d.registrado_por, p.metodo, SUM(p.valor) AS valor
         FROM documento_pagos p JOIN documentos d ON d.id = p.documento_id
        WHERE d.tipo = 'factura' AND d.anulada = false AND d.fecha BETWEEN $1 AND $2
        GROUP BY d.almacen_id, d.registrado_por, p.metodo`,
      rango
    ),
    pool.query(
      `SELECT almacen_id, registrado_por, COALESCE(SUM(valor),0) AS valor
         FROM gastos WHERE fecha BETWEEN $1 AND $2
        GROUP BY almacen_id, registrado_por`,
      rango
    ),
    pool.query(
      `SELECT almacen_id, usuario_id, COUNT(*) AS conteos,
              COALESCE(SUM(contado),0) AS contado, COALESCE(SUM(diferencia),0) AS diferencia
         FROM arqueos WHERE fecha BETWEEN $1 AND $2
        GROUP BY almacen_id, usuario_id`,
      rango
    ),
  ]);

  const porUsuario = new Map(usuarios.rows.map((u) => [u.id, u]));
  const metodosVistos = new Map(); // nombre tal como lo escribió el almacén -> tipo

  // Un cajón por almacén y, dentro, un cajón por caja.
  const cajones = new Map();
  const cajon = (almacenId) => {
    if (!cajones.has(almacenId)) cajones.set(almacenId, new Map());
    return cajones.get(almacenId);
  };
  const caja = (almacenId, usuarioId) => {
    const c = cajon(almacenId);
    const clave = usuarioId === null || usuarioId === undefined ? 0 : usuarioId;
    if (!c.has(clave)) c.set(clave, { usuarioId: clave, ...vacio() });
    return c.get(clave);
  };

  for (const v of ventas.rows) {
    const c = caja(v.almacen_id, v.registrado_por);
    c.venta += Number(v.venta);
    c.facturas += Number(v.facturas);
  }
  for (const p of pagos.rows) {
    const tipo = tipoDePago(p.metodo);
    metodosVistos.set(p.metodo, tipo);
    caja(p.almacen_id, p.registrado_por)[tipo] += Number(p.valor);
  }
  for (const g of gastos.rows) {
    caja(g.almacen_id, g.registrado_por).gastos += Number(g.valor);
  }
  for (const a of arqueos.rows) {
    const c = caja(a.almacen_id, a.usuario_id);
    c.arqueos += Number(a.conteos);
    c.contado += Number(a.contado);
    c.diferencia += Number(a.diferencia);
  }

  const filas = almacenes.rows.map((a) => {
    const movidas = [...(cajones.get(a.id) || new Map()).values()];

    // Las cajas del almacén que no movieron nada también se muestran (con ceros) cuando el
    // almacén sí tuvo movimiento: así se ve de una quién no facturó.
    const hayMovimiento = movidas.some((c) => c.venta !== 0 || c.gastos !== 0 || c.arqueos !== 0);
    const idsConMovimiento = new Set(movidas.map((c) => c.usuarioId));
    if (hayMovimiento) {
      for (const u of usuarios.rows) {
        if (u.almacen_id === a.id && u.activo && !idsConMovimiento.has(u.id)) {
          movidas.push({ usuarioId: u.id, ...vacio() });
        }
      }
    }

    const cajas = movidas
      .map((c) => {
        const u = porUsuario.get(c.usuarioId);
        return {
          ...c,
          entregar: c.efectivo - c.gastos,
          nombre: u ? u.nombre : 'Sin caja',
          usuario: u ? u.usuario : null,
          // Gastos o facturas que no salieron de una caja del almacén (por ejemplo un gasto
          // anotado por administración) van marcados para que el cuadre no desconcierte.
          ajena: Boolean(u && u.almacen_id !== a.id),
        };
      })
      .filter((c) => hayMovimiento)
      .sort((a1, b1) => b1.venta - a1.venta || a1.nombre.localeCompare(b1.nombre, 'es'));

    return {
      almacen: a,
      cajas,
      total: cajas.reduce((acc, c) => acumular(acc, c), vacio()),
    };
  });

  const totales = filas.reduce((acc, f) => acumular(acc, f.total), vacio());

  return {
    filas,
    totales,
    // Para avisar en la pantalla qué nombres de pago entraron en «otros».
    otrosMetodos: [...metodosVistos.entries()].filter(([, t]) => t === 'otros').map(([m]) => m),
    conOtros: totales.otros !== 0,
    // Solo se muestran las columnas del conteo si alguien contó su cajón en estas fechas.
    conArqueo: totales.arqueos > 0,
  };
}

module.exports = { resumenCajas, tipoDePago };
