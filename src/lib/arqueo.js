/* Arqueo de caja: contar los billetes y las monedas que hay en el cajón y compararlos
   con lo que debería haber.

   Lo que debería haber = base del día (con lo que amaneció la caja)
                        + efectivo cobrado por esa caja
                        − gastos pagados de esa caja.

   La transferencia no entra: ese dinero está en el banco, no en el cajón. */

// Billetes y monedas que circulan en Colombia.
const DENOMINACIONES = [
  { valor: 100000, tipo: 'billete' },
  { valor: 50000, tipo: 'billete' },
  { valor: 20000, tipo: 'billete' },
  { valor: 10000, tipo: 'billete' },
  { valor: 5000, tipo: 'billete' },
  { valor: 2000, tipo: 'billete' },
  { valor: 1000, tipo: 'moneda' },
  { valor: 500, tipo: 'moneda' },
  { valor: 200, tipo: 'moneda' },
  { valor: 100, tipo: 'moneda' },
  { valor: 50, tipo: 'moneda' },
];

const BILLETES = DENOMINACIONES.filter((d) => d.tipo === 'billete');
const MONEDAS = DENOMINACIONES.filter((d) => d.tipo === 'moneda');

// Deja el conteo en limpio: solo denominaciones conocidas y cantidades enteras no negativas.
function limpiarDetalle(detalle) {
  const limpio = {};
  for (const d of DENOMINACIONES) {
    const n = Math.floor(Number((detalle || {})[d.valor] ?? (detalle || {})[String(d.valor)]) || 0);
    if (n > 0) limpio[d.valor] = n;
  }
  return limpio;
}

function contar(detalle) {
  const limpio = limpiarDetalle(detalle);
  return DENOMINACIONES.reduce((acc, d) => acc + d.valor * (limpio[d.valor] || 0), 0);
}

// Líneas para pintar el conteo (en pantalla o impreso), sin las denominaciones en cero.
function lineasContadas(detalle) {
  const limpio = limpiarDetalle(detalle);
  return DENOMINACIONES.filter((d) => limpio[d.valor]).map((d) => ({
    valor: d.valor,
    tipo: d.tipo,
    cantidad: limpio[d.valor],
    subtotal: d.valor * limpio[d.valor],
  }));
}

// Cuánto efectivo movió ESTA caja (este usuario) en el día, que es contra lo que se cuenta.
async function efectivoDeLaCaja(pool, { almacenId, fecha, usuarioId }) {
  const [pagos, gastos] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(p.valor),0) AS valor
         FROM documento_pagos p JOIN documentos d ON d.id = p.documento_id
        WHERE d.almacen_id = $1 AND d.fecha = $2 AND d.tipo = 'factura' AND d.anulada = false
          AND d.registrado_por = $3 AND p.metodo ILIKE '%efectiv%'`,
      [almacenId, fecha, usuarioId]
    ),
    pool.query(
      `SELECT COALESCE(SUM(valor),0) AS valor FROM gastos
        WHERE almacen_id = $1 AND fecha = $2 AND registrado_por = $3`,
      [almacenId, fecha, usuarioId]
    ),
  ]);
  const efectivo = Number(pagos.rows[0].valor);
  const gastados = Number(gastos.rows[0].valor);
  return { efectivo, gastos: gastados, entregar: efectivo - gastados };
}

async function leerArqueo(pool, { almacenId, fecha, usuarioId }) {
  const { rows } = await pool.query(
    'SELECT * FROM arqueos WHERE almacen_id = $1 AND fecha = $2 AND usuario_id = $3',
    [almacenId, fecha, usuarioId]
  );
  if (rows.length === 0) return null;
  const a = rows[0];
  return {
    ...a,
    base: Number(a.base),
    contado: Number(a.contado),
    esperado: Number(a.esperado),
    diferencia: Number(a.diferencia),
    lineas: lineasContadas(a.detalle),
  };
}

// Guardar de nuevo el mismo día reemplaza el conteo anterior: es un borrador hasta que cierran.
async function guardarArqueo(pool, { almacenId, fecha, usuarioId, detalle, base, nota }) {
  const limpio = limpiarDetalle(detalle);
  const contado = contar(limpio);
  const fondo = Math.max(0, Number(base) || 0);
  const movido = await efectivoDeLaCaja(pool, { almacenId, fecha, usuarioId });
  const esperado = fondo + movido.entregar;

  const { rows } = await pool.query(
    `INSERT INTO arqueos (almacen_id, fecha, usuario_id, base, detalle, contado, esperado, diferencia, nota)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (almacen_id, fecha, usuario_id) DO UPDATE
       SET base = EXCLUDED.base, detalle = EXCLUDED.detalle, contado = EXCLUDED.contado,
           esperado = EXCLUDED.esperado, diferencia = EXCLUDED.diferencia, nota = EXCLUDED.nota,
           actualizado_en = now()
     RETURNING *`,
    [
      almacenId,
      fecha,
      usuarioId,
      fondo,
      JSON.stringify(limpio),
      contado,
      esperado,
      contado - esperado,
      (nota || '').trim() || null,
    ]
  );

  const a = rows[0];
  return {
    ...a,
    base: Number(a.base),
    contado: Number(a.contado),
    esperado: Number(a.esperado),
    diferencia: Number(a.diferencia),
    lineas: lineasContadas(a.detalle),
    movido,
  };
}

async function borrarArqueo(pool, { almacenId, fecha, usuarioId }) {
  await pool.query('DELETE FROM arqueos WHERE almacen_id = $1 AND fecha = $2 AND usuario_id = $3', [
    almacenId,
    fecha,
    usuarioId,
  ]);
}

module.exports = {
  DENOMINACIONES,
  BILLETES,
  MONEDAS,
  limpiarDetalle,
  contar,
  lineasContadas,
  efectivoDeLaCaja,
  leerArqueo,
  guardarArqueo,
  borrarArqueo,
};
