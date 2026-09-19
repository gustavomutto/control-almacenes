// Todo el sistema trabaja con la fecha del negocio, no la del servidor.
// El servidor de Railway corre en UTC: sin esto, una venta de las 8 de la noche
// en Colombia quedaría registrada al día siguiente y el cierre de caja saldría vacío.
const ZONA = process.env.ZONA_HORARIA || 'America/Bogota';

const formatoFecha = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONA,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// Devuelve 'AAAA-MM-DD' del día que es *hoy* en el negocio.
function hoyISO(momento = new Date()) {
  return formatoFecha.format(momento);
}

// 'AAAA-MM' del mes en curso en el negocio.
function mesActual(momento = new Date()) {
  return hoyISO(momento).slice(0, 7);
}

module.exports = { ZONA, hoyISO, mesActual };
