// Reglas de papel para imprimir: media carta, hoja carta o ticket térmico POS (58/80mm).
//
// MEDIA CARTA es el papel que de verdad está cargado en la Ricoh: 8,5 × 6,5 pulgadas
// (21,6 × 16,5 cm). Se le pide a Chrome exactamente en pulgadas, con el mismo número que
// tiene el formulario del driver, para que lo reconozca y no intente reescalar.
//
// El contenido de la factura sigue armado para 22 × 14 cm (3 cm de encabezado y 11 cm de
// productos, pago y total): entra en la hoja con 2,5 cm de sobra abajo, que es justo el
// margen de seguridad para que nunca se salga nada.
const ALTO_CONTENIDO = '130mm'; // los 14 cm del contenido menos los márgenes

// Al imprimir el ancho lo pone la hoja (los márgenes los maneja @page), no un número fijo.
const CAJA_IMPRESION = `width:100%;min-height:${ALTO_CONTENIDO}`;

const PAPELES = {
  '58mm': '@page{margin:0} #print-area .tk{width:54mm;padding:2mm;font-size:9px}',
  '80mm': '@page{margin:0} #print-area .tk{width:74mm;padding:3mm;font-size:11px}',
  // Media carta: la hoja mide 8,5 x 6,5 pulgadas.
  media:
    `@page{size:8.5in 6.5in;margin:6mm 7mm} #print-area .fx{${CAJA_IMPRESION}}` +
    ' #print-area .tk{width:125mm;margin:0 auto;font-size:11px}',
  // Hoja carta completa: la factura ocupa la parte de arriba y se corta por la línea punteada.
  carta:
    `@page{size:letter;margin:6mm 7mm} #print-area .fx{${CAJA_IMPRESION};` +
    'border-bottom:1px dashed #999;padding-bottom:4mm}' +
    ' #print-area .tk{width:125mm;margin:0 auto;font-size:13px}',
};

// Alto de la hoja en pantalla (la vista previa se ve del tamaño del papel real).
const ALTO_PANTALLA = { media: '165mm', carta: '140mm' };

function papelCss(papel) {
  const regla = PAPELES[papel] || PAPELES.carta;
  const esTicket = papel === '58mm' || papel === '80mm';

  // En pantalla mostramos el documento con el tamaño real del papel, para que lo que
  // se ve sea igual a lo que sale por la impresora.
  const alto = ALTO_PANTALLA[papel] || ALTO_PANTALLA.carta;
  const pantalla =
    `@media screen{#print-area{width:${anchoPantalla(papel)};max-width:100%;` +
    `padding:${esTicket ? '4mm 3mm' : '6mm 7mm'}}}` +
    (esTicket
      ? ''
      : `@media screen{#print-area .fx{width:100%;height:calc(${alto} - 12mm);overflow:hidden}}`);

  return pantalla + '@media print{' + regla + '}';
}

// Ancho en pantalla para que la vista previa se parezca al papel real.
function anchoPantalla(papel) {
  if (papel === '58mm') return '54mm';
  if (papel === '80mm') return '74mm';
  return '216mm';
}

// La factura no puede crecer más allá de la hoja, así que entre más productos, más
// apretada la letra. Con esto caben unas 26 líneas en la media hoja.
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
  media: 'media carta (8,5 × 6,5 pulgadas)',
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
  ALTO_PANTALLA,
  papelCss,
  anchoPantalla,
  densidadFactura,
  papelEfectivo,
  fechaTexto,
  horaTexto,
};
