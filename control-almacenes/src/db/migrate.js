const fs = require('fs');
const path = require('path');
require('dotenv').config();
const pool = require('./pool');

async function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('Migración aplicada correctamente.');
  await pool.end();
}

migrate().catch((err) => {
  console.error('Error al migrar:', err);
  process.exit(1);
});
