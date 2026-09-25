// Lectura de inventario desde Excel (.xlsx, .xls) o CSV.
const XLSX = require('xlsx');

// Nombres de columna aceptados (sin tildes ni mayúsculas) para cada campo.
const COLUMNAS = {
  nombre: ['nombre', 'producto', 'descripcion', 'articulo', 'item'],
  unidad: ['unidad', 'medida', 'und'],
  precio_venta: ['precio venta', 'precio de venta', 'precio', 'venta', 'pvp'],
  precio_costo: ['precio costo', 'precio de costo', 'costo', 'compra', 'precio compra'],
  existencias: ['existencias', 'cantidad', 'stock', 'inventario', 'saldo'],
  controla_stock: ['controla stock', 'maneja stock', 'descuenta inventario'],
};

function normalizar(texto) {
  return String(texto || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quita tildes
    .replace(/[_\-.]+/g, ' ') // "precio_venta" y "precio-venta" cuentan como "precio venta"
    .replace(/\s+/g, ' ')
    .trim();
}

// Convierte a número lo que venga: 27000, "27.000", "$ 27.000", "27,5", "1.234,56".
function aNumero(valor) {
  if (valor === null || valor === undefined || valor === '') return 0;
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : 0;

  let s = String(valor).replace(/[^\d.,-]/g, '').trim();
  if (!s) return 0;

  const tienePunto = s.includes('.');
  const tieneComa = s.includes(',');

  if (tienePunto && tieneComa) {
    // El separador decimal es el que aparece de último: "1.234,56" o "1,234.56"
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (tieneComa) {
    // "27,5" es decimal; "1,234" con 3 dígitos después es separador de miles.
    const partes = s.split(',');
    s = partes.length === 2 && partes[1].length === 3 ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (tienePunto) {
    // "27.000" son miles; "27.5" es decimal.
    const partes = s.split('.');
    if (partes.length > 2) s = s.replace(/\./g, '');
    else if (partes[1] && partes[1].length === 3) s = s.replace(/\./g, '');
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function aBooleano(valor, porDefecto = true) {
  if (valor === null || valor === undefined || valor === '') return porDefecto;
  const s = normalizar(valor);
  if (['no', 'n', 'false', '0', 'nel'].includes(s)) return false;
  if (['si', 's', 'sí', 'true', '1', 'x'].includes(s)) return true;
  return porDefecto;
}

// Devuelve {campo: nombreDeColumnaEnElArchivo} mirando los encabezados.
function mapearColumnas(encabezados) {
  const mapa = {};
  for (const [campo, alias] of Object.entries(COLUMNAS)) {
    const encontrado = encabezados.find((h) => alias.includes(normalizar(h)));
    if (encontrado) mapa[campo] = encontrado;
  }
  return mapa;
}

/**
 * Lee el archivo y devuelve { filas, errores, columnasDetectadas }.
 * Cada fila: { nombre, unidad, precio_venta, precio_costo, existencias, controla_stock }
 */
function leerInventario(buffer) {
  const libro = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const hoja = libro.Sheets[libro.SheetNames[0]];
  if (!hoja) return { filas: [], errores: ['El archivo no tiene ninguna hoja con datos.'], columnasDetectadas: {} };

  const crudas = XLSX.utils.sheet_to_json(hoja, { defval: '', raw: true });
  if (crudas.length === 0) {
    return { filas: [], errores: ['El archivo está vacío o no tiene encabezados en la primera fila.'], columnasDetectadas: {} };
  }

  const encabezados = Object.keys(crudas[0]);
  const mapa = mapearColumnas(encabezados);

  if (!mapa.nombre) {
    return {
      filas: [],
      errores: [
        `No encontré la columna del nombre del producto. Los encabezados del archivo son: ${encabezados.join(', ')}. ` +
          'Debe haber una columna llamada "nombre" o "producto".',
      ],
      columnasDetectadas: mapa,
    };
  }

  const filas = [];
  const errores = [];
  const vistos = new Set();

  crudas.forEach((fila, i) => {
    const numeroFila = i + 2; // +1 por el encabezado, +1 porque Excel empieza en 1
    const nombre = String(fila[mapa.nombre] ?? '').trim();
    if (!nombre) return; // fila en blanco: se ignora en silencio

    const clave = nombre.toLowerCase();
    if (vistos.has(clave)) {
      errores.push(`Fila ${numeroFila}: "${nombre}" está repetido en el archivo; se toma el último.`);
    }
    vistos.add(clave);

    const precioVenta = mapa.precio_venta ? aNumero(fila[mapa.precio_venta]) : 0;
    const precioCosto = mapa.precio_costo ? aNumero(fila[mapa.precio_costo]) : 0;

    if (precioVenta < 0 || precioCosto < 0) {
      errores.push(`Fila ${numeroFila}: "${nombre}" tiene un precio negativo; se deja en 0.`);
    }

    filas.push({
      fila: numeroFila,
      nombre: nombre.slice(0, 160),
      unidad: mapa.unidad ? String(fila[mapa.unidad] || '').trim().slice(0, 30) || 'unidad' : 'unidad',
      precio_venta: Math.max(0, precioVenta),
      precio_costo: Math.max(0, precioCosto),
      existencias: mapa.existencias ? aNumero(fila[mapa.existencias]) : 0,
      controla_stock: mapa.controla_stock ? aBooleano(fila[mapa.controla_stock]) : true,
    });
  });

  // Si el nombre se repite, gana la última aparición.
  const porNombre = new Map();
  for (const f of filas) porNombre.set(f.nombre.toLowerCase(), f);

  return { filas: [...porNombre.values()], errores, columnasDetectadas: mapa };
}

// Archivo de ejemplo para que el usuario sepa qué columnas poner.
function plantillaExcel() {
  const datos = [
    { nombre: 'LAMINA PVC IMP', unidad: 'unidad', precio_venta: 27000, precio_costo: 18000, existencias: 50 },
    { nombre: 'CORNISA', unidad: 'unidad', precio_venta: 8000, precio_costo: 5000, existencias: 30 },
    { nombre: 'TORNILLO LAMINA', unidad: 'unidad', precio_venta: 150, precio_costo: 90, existencias: 1000 },
  ];
  const hoja = XLSX.utils.json_to_sheet(datos);
  hoja['!cols'] = [{ wch: 30 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 13 }];
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, hoja, 'Inventario');
  return XLSX.write(libro, { type: 'buffer', bookType: 'xlsx' });
}

// Exporta el inventario que ya existe, con los mismos encabezados que luego se vuelven a leer:
// se descarga, se llena en Excel y se sube otra vez. Para el personal del almacén NO va el costo.
function inventarioExcel(productos, { conCosto = false } = {}) {
  const datos = productos.map((p) => {
    const fila = {
      nombre: p.nombre,
      unidad: p.unidad,
      precio_venta: Number(p.precio_venta),
    };
    if (conCosto) fila.precio_costo = Number(p.precio_costo);
    fila.existencias = Number(p.existencias);
    fila.controla_stock = p.controla_stock ? 'si' : 'no';
    return fila;
  });

  // Si el almacén todavía no tiene nada, se baja una fila de ejemplo para que se vea el formato.
  if (datos.length === 0) {
    const ejemplo = { nombre: 'LAMINA PVC IMP', unidad: 'unidad', precio_venta: 27000 };
    if (conCosto) ejemplo.precio_costo = 18000;
    ejemplo.existencias = 50;
    ejemplo.controla_stock = 'si';
    datos.push(ejemplo);
  }

  const hoja = XLSX.utils.json_to_sheet(datos);
  hoja['!cols'] = [{ wch: 36 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }];
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, hoja, 'Inventario');
  return XLSX.write(libro, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { leerInventario, plantillaExcel, inventarioExcel, aNumero, aBooleano };
