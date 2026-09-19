const { Pool } = require('pg');

// Railway inyecta DATABASE_URL automáticamente cuando se agrega un plugin de Postgres.
// En desarrollo local se puede usar un .env con DATABASE_URL propio.
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('Falta la variable de entorno DATABASE_URL. Revisa tu archivo .env o las variables del servicio en Railway.');
  process.exit(1);
}

const useSsl = /sslmode=require/.test(connectionString) || process.env.PGSSL === 'true';

// La base también trabaja en la hora del negocio: así CURRENT_DATE y now() coinciden
// con el día real en Colombia y no con el del servidor (que corre en UTC).
const ZONA = process.env.ZONA_HORARIA || 'America/Bogota';

const pool = new Pool({
  connectionString,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  options: `-c timezone=${ZONA}`,
});

module.exports = pool;
