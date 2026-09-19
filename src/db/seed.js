require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('./pool');

// Genera una contraseña legible y razonablemente segura (evita caracteres ambiguos).
function generarPassword() {
  const letras = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 10; i++) out += letras[Math.floor(Math.random() * letras.length)];
  return out;
}

const ALMACENES = (process.env.SEED_ALMACENES || 'Almacén 1,Almacén 2,Almacén 3,Almacén 4')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Rescate: si te quedas por fuera y nadie puede entrar como administrador,
// crea en Railway la variable CLAVE_ADMIN (y/o CLAVE_JEFA) con la clave que quieras.
// En el siguiente despliegue se le pone esa clave a ese usuario. Después
// BORRA la variable, para que la clave no quede escrita en la configuración.
async function rescatarClaves(client) {
  const rescates = [
    ['admin', process.env.CLAVE_ADMIN],
    ['jefa', process.env.CLAVE_JEFA],
  ];

  for (const [rol, clave] of rescates) {
    if (!clave || String(clave).length < 4) continue;
    const hash = await bcrypt.hash(String(clave), 10);
    const { rows } = await client.query(
      `UPDATE usuarios SET password_hash = $1, activo = true WHERE rol = $2 RETURNING usuario`,
      [hash, rol]
    );
    if (rows.length > 0) {
      console.log(
        `CLAVE RESTABLECIDA para el rol "${rol}" (usuario: ${rows
          .map((r) => r.usuario)
          .join(', ')}). Borra ya la variable de Railway.`
      );
    } else {
      console.log(`No hay ningún usuario con rol "${rol}" al que restablecerle la clave.`);
    }
  }
}

async function seed() {
  const client = await pool.connect();
  const credenciales = [];
  try {
    await client.query('BEGIN');

    // Usuario jefa (consolidado, solo lectura)
    const { rows: jefaExiste } = await client.query("SELECT id FROM usuarios WHERE rol = 'jefa' LIMIT 1");
    if (jefaExiste.length === 0) {
      const pass = generarPassword();
      const hash = await bcrypt.hash(pass, 10);
      await client.query(
        `INSERT INTO usuarios (almacen_id, usuario, password_hash, nombre, rol) VALUES (NULL, $1, $2, $3, 'jefa')`,
        ['jefa', hash, 'Jefa']
      );
      credenciales.push({ usuario: 'jefa', password: pass, rol: 'jefa / vista consolidada' });
    }

    // Usuario admin (tú), ve todo y puede administrar
    const { rows: adminExiste } = await client.query("SELECT id FROM usuarios WHERE rol = 'admin' LIMIT 1");
    if (adminExiste.length === 0) {
      const pass = generarPassword();
      const hash = await bcrypt.hash(pass, 10);
      await client.query(
        `INSERT INTO usuarios (almacen_id, usuario, password_hash, nombre, rol) VALUES (NULL, $1, $2, $3, 'admin')`,
        ['admin', hash, 'Administrador']
      );
      credenciales.push({ usuario: 'admin', password: pass, rol: 'administrador' });
    }

    for (const nombre of ALMACENES) {
      let almacenId;
      const { rows } = await client.query('SELECT id FROM almacenes WHERE nombre = $1', [nombre]);
      if (rows.length > 0) {
        almacenId = rows[0].id;
      } else {
        const ins = await client.query('INSERT INTO almacenes (nombre) VALUES ($1) RETURNING id', [nombre]);
        almacenId = ins.rows[0].id;
      }

      const usuarioLogin = nombre
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '');

      const { rows: existeUsuario } = await client.query(
        "SELECT id FROM usuarios WHERE almacen_id = $1 AND rol = 'almacen' LIMIT 1",
        [almacenId]
      );
      if (existeUsuario.length === 0) {
        const pass = generarPassword();
        const hash = await bcrypt.hash(pass, 10);
        await client.query(
          `INSERT INTO usuarios (almacen_id, usuario, password_hash, nombre, rol) VALUES ($1, $2, $3, $4, 'almacen')`,
          [almacenId, usuarioLogin, hash, nombre]
        );
        credenciales.push({ usuario: usuarioLogin, password: pass, rol: `personal de ${nombre}` });
      }
    }

    await rescatarClaves(client);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  if (credenciales.length > 0) {
    console.log('\n=== Credenciales creadas (guárdalas, no se volverán a mostrar así) ===');
    for (const c of credenciales) {
      console.log(`  usuario: ${c.usuario.padEnd(14)}  clave: ${c.password.padEnd(12)}  (${c.rol})`);
    }
    console.log('========================================================================\n');
  } else {
    console.log('No se crearon usuarios nuevos (ya existían).');
  }

  await pool.end();
}

seed().catch((err) => {
  console.error('Error al crear datos iniciales:', err);
  process.exit(1);
});
