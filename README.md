# Control de almacenes — facturación, inventario y rentabilidad

Sistema web para varios almacenes. Cada almacén tiene su propio sitio de facturación
(vender, cotizar, inventario, caja) y la administración ve el consolidado con la ganancia real.

## Quién ve qué

| | Personal del almacén | Jefa | Administrador |
|---|---|---|---|
| Facturar y cotizar | Sí (solo su almacén) | No | No |
| Inventario y precios de venta | Sí (su almacén) | Consulta | Consulta |
| **Precio de costo y ganancia** | **No lo ve nunca** | Sí | Sí |
| Reportes de todos los almacenes | No | Sí | Sí |
| Crear/borrar almacenes, sedes y usuarios | No | Sí | Sí |

La idea de fondo: **el vendedor factura al precio que quiera**; el costo lo pone la
administración y la ganancia se calcula solo para ellos.

## El sitio de cada almacén

- **Facturar**: busca productos (escribe `3*lamina` para 3 unidades), precio editable línea
  por línea, descuento, IVA 19% opcional, varias formas de pago con cálculo de cambio, y
  vista previa de cómo saldrá impresa. Al cobrar, descuenta el inventario.
- **Cotizar**: calculadora de metros cuadrados para techos PVC (lámina, cornisa, omega,
  vigueta, ángulo y tornillos, con las mismas fórmulas del programa original) más productos
  sueltos. Las cotizaciones no mueven inventario.
- **Facturas**: historial por día, reimprimir y anular (al anular, el inventario se devuelve).
- **Productos**: catálogo con precio de venta, unidad y existencias; registrar entradas de
  mercancía.
- **Caja**: cuadre del día por forma de pago, gastos del día y «efectivo a entregar»
  (efectivo cobrado menos gastos), con cierre imprimible.
- **Mis datos**: encabezado, dirección, NIT, teléfono, nota al pie y formas de pago que salen
  impresos.

## Impresión

Cada almacén se configura en hoja carta o en ticket POS térmico (80mm o 58mm) desde
«Almacenes y usuarios». Hoy:

| Almacén | Sede | Impresión |
|---|---|---|
| PVC La 11 | Valledupar | Ticket POS 80mm |
| Techos PVC | Valledupar | Hoja carta |
| Universal Viviana | Valledupar | Hoja carta |
| PVElectricos | Valledupar | Hoja carta |

## Sedes / regiones

Un almacén pertenece a una sede (por ejemplo Valledupar). Desde «Almacenes y usuarios» se
crean sedes nuevas, se crean almacenes asignándoles sede e impresión, y se borran almacenes
(escribiendo su nombre exacto como confirmación, porque se borra con todas sus facturas,
productos y gastos). Los reportes de la jefa agrupan por sede.

## Cómo se calcula la ganancia

En «Costos» la administración define el precio de costo de cada producto. Al guardar una
factura, el sistema toma ese costo y lo guarda como una foto dentro de la factura, así que
cambiar el costo después no altera las facturas viejas.

    ganancia = (lo cobrado sin IVA y ya con el descuento) − (costo de la mercancía vendida)

Los gastos se muestran **aparte**, nunca se restan solos de esa ganancia.

## Estructura del proyecto

```
src/
  server.js                       servidor (Express)
  lib/calculos.js                  totales, IVA y fórmulas de m²
  lib/impresion.js                 reglas de papel (carta / 80mm / 58mm)
  db/schema.sql                    estructura de la base de datos (Postgres)
  db/migrate.js                     crea/actualiza las tablas
  db/actualizar_valledupar.js       puesta a punto de los 4 almacenes (segura de repetir)
  db/seed.js                        usuarios iniciales
  routes/auth.js                    login / logout
  routes/almacen.js                 facturar, cotizar, productos, caja, impresión
  routes/jefa.js                    consolidado, reportes, costos, administración
  views/                            páginas (EJS)
public/css/estilo.css               estilos
public/css/ticket.css               formato del ticket/factura impresa
public/js/pos.js                    pantalla de venta
public/js/cotizar.js                pantalla de cotización
```

## Desplegar en Railway

1. Subir el código al repositorio de GitHub conectado al servicio.
2. El servicio necesita un Postgres (variable `DATABASE_URL`) y estas variables:
   `SESSION_SECRET`, `NODE_ENV=production` y, opcional, `SEED_ALMACENES`.
3. Antes de cada despliegue se ejecuta:
   `node src/db/migrate.js && node src/db/actualizar_valledupar.js && node src/db/seed.js`
   (crear tablas → poner a punto almacenes/sede → crear usuarios que falten).
   Todo es seguro de repetir: si ya se aplicó, no hace nada.

## Desarrollo local

```
npm install
cp .env.example .env      # apunta DATABASE_URL a tu Postgres local
npm run migrate
npm run seed
npm start                 # http://localhost:3000
```

## Ideas para más adelante

- Carga masiva de productos desde Excel/CSV.
- Convertirlo en producto multi-negocio con cobro de mensualidad.
- Gráficas de ventas y rentabilidad.
