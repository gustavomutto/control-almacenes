// Reglas de papel para imprimir: media carta, hoja carta o ticket térmico POS (58/80mm).
//
// MEDIA CARTA es el papel que de verdad está cargado en la Ricoh: 8,5 × 6,5 pulgadas
// (21,6 × 16,5 cm). El sistema NO le impone el tamaño a la impresora: usa el que tenga
// configurado el driver y arma la factura dentro de él. Así no hay discusión de formatos
// con equipos que validan el tamaño del trabajo contra el de la bandeja.
//
// El contenido de la factura sigue armado para 22 × 14 cm (3 cm de encabezado y 11 cm de
// productos, pago y total): entra en la hoja con 2,5 cm de sobra abajo, que es justo el
// margen de seguridad para que nunca se salga nada.
// Alto FIJO del bloque al imprimir, siempre algo menor que el área útil de la hoja.
// Va fijo a propósito: con min-height, un milímetro de más empujaba una segunda hoja en
// blanco y la impresora la reportaba como atasco. Si el contenido no cupiera, un script
// en la página de impresión encoge la letra hasta que quepa, en vez de saltar de hoja.
const ALTO_IMPRESION = { media: '150mm', carta: '130mm' };

function cajaImpresion(papel) {
  return (
    `width:100%;height:${ALTO_IMPRESION[papel]};overflow:hidden;` +
    'break-inside:avoid;page-break-inside:avoid;break-after:avoid;page-break-after:avoid'
  );
}

// Nada puede empujar una segunda hoja.
const UNA_SOLA_HOJA =
  'html,body{margin:0!important;padding:0!important;height:auto!important}' +
  ' #print-area{margin:0!important;padding:0!important;overflow:hidden!important;' +
  'break-after:avoid!important;page-break-after:avoid!important}';

const PAPELES = {
  '58mm': '@page{margin:0} #print-area .tk{width:54mm;padding:2mm;font-size:9px}',
  '80mm': '@page{margin:0} #print-area .tk{width:74mm;padding:3mm;font-size:11px}',
  // IMPORTANTE: ni «media» ni «carta» le dicen a la impresora de qué tamaño es la hoja.
  // El tamaño lo manda el driver (lo que esté configurado en la impresora), y la factura
  // simplemente se arma dentro de ese papel. Cuando la página imponía el tamaño con
  // @page size, la Ricoh comparaba ese tamaño con el de la bandeja y rechazaba el trabajo;
  // los equipos de oficina son estrictos con eso, a diferencia de una impresora sencilla.
  media:
    `@page{margin:5mm 7mm} ${UNA_SOLA_HOJA} #print-area .fx{${cajaImpresion('media')}}` +
    ' #print-area .tk{width:125mm;margin:0 auto;font-size:11px}',
  // Igual, pero el bloque mide 13 cm y lleva la línea de corte para la hoja carta completa.
  carta:
    `@page{margin:5mm 7mm} ${UNA_SOLA_HOJA} #print-area .fx{${cajaImpresion('carta')};` +
    'border-bottom:1px dashed #999}' +
    ' #print-area .tk{width:125mm;margin:0 auto;font-size:13px}',
};

// Alto de la hoja en pantalla (la vista previa se ve del tamaño del papel real).
const ALTO_PANTALLA = { media: '165mm', carta: '140mm' };

function papelCss(papel) {
  const regla = PAPELES[papel] || PAPELES.carta;
  const esTicket = papel === '58mm' || papel === '80mm';

  // En pantalla mostramos el documento con el tamaño real del papel, para que lo que
  // se ve sea igual a lo que sale por la impresora.
  const pantalla =
    `@media screen{#print-area{width:${anchoPantalla(papel)};max-width:100%;` +
    `padding:${esTicket ? '4mm 3mm' : '5mm 7mm'}}}` +
    (esTicket
      ? ''
      : `@media screen{#print-area .fx{width:100%;height:${ALTO_IMPRESION[papel] || ALTO_IMPRESION.carta};overflow:hidden}}`);

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
  media: 'media carta (el tamaño lo pone la impresora)',
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
  ALTO_IMPRESION,
  NOMBRES_PAPEL,
  ALTO_PANTALLA,
  papelCss,
  anchoPantalla,
  densidadFactura,
  papelEfectivo,
  fechaTexto,
  horaTexto,
};
