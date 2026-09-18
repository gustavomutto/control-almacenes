// Actualización de datos (no de esquema): renombra los almacenes iniciales a sus
// nombres reales y los agrupa en la región Valledupar. Seguro de ejecutar varias
// veces — si ya se aplicó, no hace nada.
require('dotenv').config();
const pool = require('./pool');

const REGION = 'Valledupar';

// [nombre anterior, nombre nuevo]
const RENOMBRES = [
  ['Almacén 1', 'PVC La 11'],
  ['Almacén 2', 'Techos PVC'],
  ['Almacén 3', 'Universal Viviana'],
  ['Almacén 4', 'PVElectricos'],
];

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const regionRes = await client.query(
      `INSERT INTO regiones (nombre) VALUES ($1)
       ON CONFLICT (nombre) DO UPDATE SET nombre = EXCLUDED.nombre
       RETURNING id`,
      [REGION]
    );
    const regionId = regionRes.rows[0].id;

    for (const [antiguo, nuevo] of RENOMBRES) {
      const { rows: porAntiguo } = await client.query('SELECT id FROM almacenes WHERE nombre = $1', [antiguo]);

      if (porAntiguo.length > 0) {
        const almacenId = porAntiguo[0].id;
        await client.query('UPDATE almacenes SET nombre = $1, region_id = $2 WHERE id = $3', [nuevo, regionId, almacenId]);
        await client.query(`UPDATE usuarios SET nombre = $1 WHERE almacen_id = $2 AND rol = 'almacen'`, [nuevo, almacenId]);
        console.log(`Actualizado: "${antiguo}" -> "${nuevo}" (región ${REGION})`);
        continue;
      }

      // Ya se renombró antes (o se creó directo con el nombre nuevo): solo aseguramos la región.
      const { rows: porNuevo } = await client.query('SELECT id, region_id FROM almacenes WHERE nombre = $1', [nuevo]);
      if (porNuevo.length > 0 && !porNuevo[0].region_id) {
        await client.query('UPDATE almacenes SET region_id = $1 WHERE id = $2', [regionId, porNuevo[0].id]);
        console.log(`Región asignada a "${nuevo}"`);
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await pool.end();
}

run().catch((err) => {
  console.error('Error actualizando almacenes/región:', err);
  process.exit(1);
});
