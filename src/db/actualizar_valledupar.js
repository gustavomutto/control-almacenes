// Puesta a punto de los datos (no del esquema). Seguro de ejecutar muchas veces.
//
//  1. Crea la región Valledupar.
//  2. Identifica los almacenes ORIGINALES por su usuario (almacen1..almacen4), no por el
//     nombre, para no depender de acentos ni codificación.
//  3. Elimina almacenes duplicados VACÍOS que se hayan creado con los nombres nuevos.
//  4. Renombra los originales y los agrupa en Valledupar.
//  5. Deja PVC La 11 imprimiendo en ticket POS 80mm y los demás en hoja carta.
//  6. Borra de una sola vez los datos de prueba del sistema anterior (ventas/materiales).
require('dotenv').config();
const pool = require('./pool');

const REGION = 'Valledupar';

// [usuario del almacén, nombre nuevo, papel de impresión]
const MAPA = [
  ['almacen1', 'PVC La 11', '80mm'],
  ['almacen2', 'Techos PVC', 'carta'],
  ['almacen3', 'Universal Viviana', 'carta'],
  ['almacen4', 'PVElectricos', 'carta'],
];

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const reg = await client.query(
      `INSERT INTO regiones (nombre) VALUES ($1)
       ON CONFLICT (nombre) DO UPDATE SET nombre = EXCLUDED.nombre RETURNING id`,
      [REGION]
    );
    const regionId = reg.rows[0].id;

    for (const [login, nombreNuevo, papel] of MAPA) {
      const orig = await client.query(
        `SELECT a.id, a.nombre FROM usuarios u JOIN almacenes a ON a.id = u.almacen_id WHERE u.usuario = $1`,
        [login]
      );
      if (orig.rows.length === 0) {
        console.log(`(sin cambios) no existe el usuario ${login}`);
        continue;
      }
      const origId = orig.rows[0].id;
      const origNombre = orig.rows[0].nombre;

      // Duplicados creados por error con el nombre nuevo: se eliminan solo si están vacíos.
      const dup = await client.query('SELECT id FROM almacenes WHERE nombre = $1 AND id <> $2', [nombreNuevo, origId]);
      for (const d of dup.rows) {
        const { rows: uso } = await client.query(
          `SELECT
             (SELECT count(*) FROM documentos WHERE almacen_id = $1) AS documentos,
             (SELECT count(*) FROM gastos WHERE almacen_id = $1) AS gastos,
             (SELECT count(*) FROM productos WHERE almacen_id = $1) AS productos`,
          [d.id]
        );
        const vacio =
          Number(uso[0].documentos) === 0 && Number(uso[0].gastos) === 0 && Number(uso[0].productos) === 0;
        if (vacio) {
          await client.query('DELETE FROM almacenes WHERE id = $1', [d.id]);
          console.log(`Duplicado vacío eliminado: "${nombreNuevo}" (id ${d.id})`);
        } else {
          throw new Error(`El duplicado "${nombreNuevo}" (id ${d.id}) tiene datos: no se elimina solo.`);
        }
      }

      await client.query(
        `UPDATE almacenes
         SET nombre = $1, region_id = $2,
             papel = CASE WHEN papel IS NULL OR papel = '' OR papel = 'carta' THEN $3 ELSE papel END,
             encabezado = CASE WHEN encabezado = '' THEN $1 ELSE encabezado END
         WHERE id = $4`,
        [nombreNuevo, regionId, papel, origId]
      );
      await client.query(`UPDATE usuarios SET nombre = $1 WHERE almacen_id = $2 AND rol = 'almacen'`, [
        nombreNuevo,
        origId,
      ]);
      console.log(`OK: ${login}: "${origNombre}" -> "${nombreNuevo}" (${REGION}, papel ${papel})`);
    }

    // Limpieza única del sistema anterior (ventas y materiales de prueba).
    const viejas = await client.query(
      `SELECT to_regclass('public.ventas') AS ventas, to_regclass('public.materiales') AS materiales`
    );
    if (viejas.rows[0].ventas) {
      await client.query('DROP TABLE IF EXISTS ventas CASCADE');
      console.log('Tabla "ventas" del sistema anterior eliminada.');
    }
    if (viejas.rows[0].materiales) {
      await client.query('DROP TABLE IF EXISTS materiales CASCADE');
      console.log('Tabla "materiales" del sistema anterior eliminada.');
    }

    await client.query('COMMIT');

    const fin = await client.query(
      `SELECT a.nombre, a.papel, r.nombre AS region,
              (SELECT count(*) FROM documentos d WHERE d.almacen_id = a.id) AS documentos
       FROM almacenes a LEFT JOIN regiones r ON r.id = a.region_id ORDER BY a.nombre`
    );
    console.log('ESTADO FINAL:');
    for (const f of fin.rows) {
      console.log(`  - ${f.nombre} | ${f.region || 'sin región'} | papel: ${f.papel} | documentos: ${f.documentos}`);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await pool.end();
}

run().catch((err) => {
  console.error('Error en la puesta a punto:', err.message);
  process.exit(1);
});
