// Cálculos compartidos entre el servidor y la página (mismas reglas en ambos lados).

const IVA = 0.19;

// Materiales que se calculan solos a partir de los metros cuadrados (cotización de techos PVC).
// Las cantidades se redondean hacia arriba, igual que en el programa original.
const MATERIALES_M2 = [
  { clave: 'lamina', nombre: 'LAMINA PVC IMP', texto: 'm² ÷ 1,79', factor: (m) => m / 1.79 },
  { clave: 'cornisa', nombre: 'CORNISA', texto: '1,2 × m² ÷ 6', factor: (m) => (1.2 * m) / 6 },
  { clave: 'omega', nombre: 'OMEGA', texto: '7 × m² ÷ 10', factor: (m) => (7 * m) / 10 },
  { clave: 'vigueta', nombre: 'VIGUETA', texto: '5 × m² ÷ 10', factor: (m) => (5 * m) / 10 },
  { clave: 'angulo', nombre: 'ANGULO', texto: '8 × m² ÷ 10', factor: (m) => (8 * m) / 10 },
  { clave: 'tornillo_lamina', nombre: 'TORNILLO LAMINA', texto: '10 × m²', factor: (m) => 10 * m },
  { clave: 'tornillo_estructura', nombre: 'TORNILLO ESTRUCTURA', texto: '10 × m²', factor: (m) => 10 * m },
];

// items: [{ cantidad, precio_unit }]
function calcularTotales(items, descuento, cobraIva) {
  const subtotal = (items || []).reduce(
    (acc, i) => acc + (Number(i.cantidad) || 0) * (Number(i.precio_unit) || 0),
    0
  );
  const desc = Math.min(Math.max(Number(descuento) || 0, 0), subtotal);
  const base = subtotal - desc;
  const iva = cobraIva ? Math.round(base * IVA) : 0;
  return {
    subtotal: redondear(subtotal),
    descuento: redondear(desc),
    iva: redondear(iva),
    total: redondear(base + iva),
  };
}

function redondear(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

module.exports = { IVA, MATERIALES_M2, calcularTotales, redondear };
