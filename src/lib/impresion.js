// Reglas de papel para imprimir: media carta, hoja carta o ticket térmico POS (58/80mm).
//
// La factura SIEMPRE cabe en 22 cm de ancho por 14 cm de alto:
//   · 3 cm para los datos del almacén (encabezado)
//   · 11 cm para los productos, la forma de pago y el total
// Es media hoja carta. Quien tenga la impresora cargada con media carta usa «media»;
// quien imprima en hoja carta completa usa «carta» y corta por la línea punteada.
// 22 x 14 cm menos los márgenes. Al imprimir se usa min-height: si algún día una factura
// trae tantos productos que no caben ni con la letra más apretada, preferimos que siga en
// otra media hoja antes que recortar un producto sin avisar.
const CAJA = 'width:204mm;min-height:130mm';
const CAJA_PANTALLA = 'width:204mm;height:130mm;overflow:hidden';

const PAPELES = {
  '58mm': '@page{margin:0} #print-area .tk{width:54mm;padding:2mm;font-size:9px}',
  '80mm': '@page{margin:0} #print-area .tk{width:74mm;padding:3mm;font-size:11px}',
  // Media carta de verdad: la hoja mide 22 x 14 cm.
  media: `@page{size:216mm 140mm;margin:5mm 6mm} #print-area .fx{${CAJA}}` +
    ' #print-area .tk{width:125mm;margin:0 auto;font-size:11px}',
  // Hoja carta completa: la factura ocupa la mitad de arriba y se corta.
  carta: `@page{size:letter;margin:6mm 6mm} #print-area .fx{${CAJA};border-bottom:1px dashed #999;padding-bottom:4mm}` +
    ' #print-area .tk{width:125mm;margin:0 auto;font-size:13px}',
};

function papelCss(papel) {
  const regla = PAPELES[papel] || PAPELES.carta;
  // En pantalla mostramos el documento con el ancho real del papel, para que lo que
  // se ve sea igual a lo que sale por la impresora.
  const esTicket = papel === '58mm' || papel === '80mm';
  const pantalla =
    `@media screen{#print-area{width:${anchoPantalla(papel)};max-width:100%;` +
    `padding:${esTicket ? '4mm 3mm' : '5mm 6mm'}}}` +
    (esTicket ? '' : `@media screen{#print-area .fx{${CAJA_PANTALLA}}}`);
  return pantalla + '@media print{' + regla + '}';
}

// Ancho en pantalla para que la vista previa se parezca al papel real.
function anchoPantalla(papel) {
  if (papel === '58mm') return '54mm';
  if (papel === '80mm') return '74mm';
  return '216mm';
}

// La factura no puede crecer más allá de 14 cm, así que entre más productos, más
// apretada la letra. Con esto caben hasta unas 24 líneas en la media hoja.
function densidadFactura(lineas) {
  const n = Number(lineas) || 0;
  if (n <= 6) return '';
  if (n <= 9) return 'd2';
  if (n <= 13) return 'd3';
  if (n <= 18) return 'd4';
  return 'd5';
}

// El papel que usa de verdad una caja: el suyo si lo tiene configurado, si no el del almacén.
function papelEfectivo(usuario, almacen) {
  return (usuario && usuario.papel) || (almacen && almacen.papel) || 'carta';
}

const NOMBRES_PAPEL = {
  media: 'media carta (22 × 14 cm)',
  carta: 'hoja carta (se corta a la mitad)',
  '80mm': 'ticket 80mm',
  '58mm': 'ticket 58mm',
};

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

module.exports = {
  PAPELES,
  NOMBRES_PAPEL,
  papelCss,
  anchoPantalla,
  densidadFactura,
  papelEfectivo,
  fechaTexto,
  horaTexto,
};
