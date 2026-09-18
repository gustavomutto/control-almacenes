// Exige sesión iniciada y, opcionalmente, un rol específico.
function requireLogin(rolesPermitidos) {
  return (req, res, next) => {
    const usuario = req.session.usuario;
    if (!usuario) return res.redirect('/login');
    if (rolesPermitidos && !rolesPermitidos.includes(usuario.rol)) {
      return res.status(403).render('403');
    }
    next();
  };
}

module.exports = { requireLogin };
