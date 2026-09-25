// Cargar inventario desde un archivo de Excel, en dos pasos: revisar y aplicar.
//
// Lo usan dos pantallas distintas:
//   - el personal del almacén, desde «Productos» (sin costos: ni los ve ni los puede cambiar)
//   - admin/jefa, desde «Subir Excel» (con costos, para cualquier almacén)
//
// La diferencia entre las dos es una sola bandera, `conCosto`. Todo lo demás es igual.

const { leerInventario } = require('./importar');

// Paso 1: leer el archivo y decir qué se crearía y qué se actualizaría. No toca la base.
async function revisarInventario(pool, almacenId, buffer) {
  const lectura = leerInventario(buffer);
  if (lectura.filas.length === 0) return { ...lectura, filas: [] };

  const { rows: existentes } = await pool.query(
    'SELECT id, nombre, unidad, precio_venta, precio_costo, existencias FROM productos WHERE almacen_id = $1',
    [almacenId]
  );
  const porNombre = new Map(existentes.map((p) => [p.nombre.toLowerCase(), p]));

  const filas = lectura.filas.map((f) => {
    const actual = porNombre.get(f.nombre.toLowerCase());
    return { ...f, accion: actual ? 'actualizar' : 'crear', actual: actual || null };
  });

  return {
    filas,
    errores: lectura.errores,
    columnas: lectura.columnasDetectadas,
    nuevos: filas.filter((f) => f.accion === 'crear').length,
    actualizados: filas.filter((f) => f.accion === 'actualizar').length,
    invertidas: filas.filter(
      (f) => Number(f.precio_costo) > Number(f.precio_venta) && Number(f.precio_venta) > 0
    ).length,
  };
}

// Paso 2: guardar. Todo dentro de una transacción: o entra el archivo completo, o no entra nada.
async function aplicarInventario(pool, { almacenId, filas, modo = 'reemplazar', invertir = false, conCosto = false }) {
  if (!almacenId) throw new Error('Falta el almacén.');
  if (!Array.isArray(filas) || filas.length === 0) throw new Error('No hay nada que importar.');

  const client = await pool.connect();
  let creados = 0;
  let actualizados = 0;
  try {
    await client.query('BEGIN');
    for (const f of filas) {
      const nombre = String(f.nombre || '').trim();
      if (!nombre) continue;

      // Si el archivo traía las columnas de precio cambiadas, se enderezan antes de guardar.
      const venta = Number(invertir ? f.precio_costo : f.precio_venta) || 0;
      const costo = conCosto ? Number(invertir ? f.precio_venta : f.precio_costo) || 0 : 0;

      const { rows } = await client.query(
        `INSERT INTO productos (almacen_id, nombre, unidad, precio_venta, precio_costo, existencias, controla_stock)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (almacen_id, nombre) DO UPDATE SET
           unidad = EXCLUDED.unidad,
           precio_venta = EXCLUDED.precio_venta,
           -- El costo solo lo toca quien puede verlo; si no, se deja el que ya estaba.
           precio_costo = CASE WHEN $9 THEN EXCLUDED.precio_costo ELSE productos.precio_costo END,
           existencias = CASE WHEN $8 = 'sumar' THEN productos.existencias + EXCLUDED.existencias
                              ELSE EXCLUDED.existencias END,
           controla_stock = EXCLUDED.controla_stock,
           activo = true,
           actualizado_en = now()
         RETURNING (xmax = 0) AS fue_creado`,
        [
          almacenId,
          nombre,
          String(f.unidad || 'unidad').slice(0, 30),
          venta,
          costo,
          Number(f.existencias) || 0,
          f.controla_stock !== false,
          modo === 'sumar' ? 'sumar' : 'reemplazar',
          conCosto,
        ]
      );
      if (rows[0].fue_creado) creados++;
      else actualizados++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { creados, actualizados };
}

// Lo que viaja en el formulario entre el paso 1 y el paso 2 (sin el costo si no corresponde).
function filasParaFormulario(filas, conCosto) {
  return filas.map((f) => ({
    nombre: f.nombre,
    unidad: f.unidad,
    precio_venta: f.precio_venta,
    precio_costo: conCosto ? f.precio_costo : 0,
    existencias: f.existencias,
    controla_stock: f.controla_stock,
  }));
}

module.exports = { revisarInventario, aplicarInventario, filasParaFormulario };
