const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session.usuario) return res.redirect('/');
  res.render('login', { error: null });
});

router.post('/login', async (req, res) => {
  const { usuario, password } = req.body;
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.usuario, u.password_hash, u.nombre, u.rol, u.almacen_id, u.papel,
              a.nombre AS almacen_nombre
       FROM usuarios u
       LEFT JOIN almacenes a ON a.id = u.almacen_id
       WHERE u.usuario = $1 AND u.activo = true`,
      [(usuario || '').trim().toLowerCase()]
    );

    const fila = rows[0];
    const ok = fila && (await bcrypt.compare(password || '', fila.password_hash));
    if (!ok) {
      return res.status(401).render('login', { error: 'Usuario o clave incorrectos.' });
    }

    req.session.usuario = {
      id: fila.id,
      usuario: fila.usuario,
      nombre: fila.nombre,
      rol: fila.rol,
      almacenId: fila.almacen_id,
      almacenNombre: fila.almacen_nombre,
      papel: fila.papel || null, // papel propio de esta caja; si está vacío, el del almacén
    };
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.status(500).render('login', { error: 'Ocurrió un error. Intenta de nuevo.' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
