// Reglas de papel para imprimir: ticket térmico POS (58/80mm) u hoja carta.
const PAPELES = {
  '58mm': '@page{margin:0} #print-area .tk{width:54mm;padding:2mm;font-size:9px}',
  '80mm': '@page{margin:0} #print-area .tk{width:74mm;padding:3mm;font-size:11px}',
  // En carta, la factura usa el ancho útil de la hoja (.fx); los documentos que siguen
  // con el formato de tirilla (.tk) van centrados a 125mm.
  carta:
    '@page{size:letter;margin:14mm} #print-area .fx{width:100%;font-size:12.5px}' +
    ' #print-area .tk{width:125mm;margin:0 auto;font-size:13px}',
};

function papelCss(papel) {
  const regla = PAPELES[papel] || PAPELES.carta;
  // En pantalla mostramos el documento con el ancho real del papel, para que lo que
  // se ve sea igual a lo que sale por la impresora.
  const pantalla =
    `@media screen{#print-area{width:${anchoPantalla(papel)};max-width:100%;` +
    `padding:${papel === 'carta' ? '18mm 12mm' : '4mm 3mm'}}}`;
  return pantalla + '@media print{' + regla + '}';
}

// Ancho en pantalla para que la vista previa se parezca al papel real.
function anchoPantalla(papel) {
  if (papel === '58mm') return '54mm';
  if (papel === '80mm') return '74mm';
  return '188mm'; // hoja carta menos los márgenes
}

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

function fechaTexto(fecha) {
  const d = fecha instanceof Date ? fecha : new Date(String(fecha) + 'T12:00:00');
  return `${d.getDate()} de ${MESES[d.getMonth()]} de ${d.getFullYear()}`;
}

function horaTexto(fechaHora) {
  const d = fechaHora ? new Date(fechaHora) : new Date();
  return d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' });
}

module.exports = { PAPELES, papelCss, anchoPantalla, fechaTexto, horaTexto };
