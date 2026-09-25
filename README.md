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
| Trasladar mercancía a otro almacén | Sí (desde el suyo) | Sí (desde cualquiera) | Sí (desde cualquiera) |
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
  mercancía, y cargar el inventario desde Excel (se descarga como está hoy, se llena y se sube).
- **Traslados**: hoja para mandar mercancía a otro almacén, sin precios. Sale del inventario de
  aquí y entra al de allá.
- **Movimiento**: qué material salió hoy —vendido, trasladado— y qué entró, imprimible.
- **Caja**: cuadre del día por forma de pago, gastos del día y «efectivo a entregar»
  (efectivo cobrado menos gastos), con cierre imprimible.
- **Mis datos**: encabezado, dirección, NIT, teléfono, nota al pie y formas de pago que salen
  impresos.

## Traslados entre almacenes

Mandar mercancía a otro almacén **no es una venta**: no lleva precio, no entra a la caja y no
cambia la ganancia de nadie. (Facturar a cero pesos sería peor: el que envía se comería el costo
como pérdida y el que recibe quedaría con ganancia inflada.)

En «Traslados» se arma la hoja con los productos del propio catálogo y las cantidades, se elige el
almacén que recibe y quién lleva la mercancía, y se imprime con espacio para las dos firmas. Al
guardar, la mercancía sale del inventario de origen y entra al de destino en el mismo momento. Si
el producto no existe en el almacén que recibe, se crea allá con su nombre, unidad y **precio de
costo**, para que la ganancia de ese almacén salga bien cuando lo venda; si ya existía, solo se le
suma la cantidad y no se le tocan sus precios.

Puede hacer una hoja el propio almacén que envía y también admin/jefa desde su panel, donde además
se ve el historial completo con filtros por almacén y fecha. Un traslado se puede anular y todo
vuelve a su sitio; si el almacén de destino ya vendió esa mercancía, el sistema no deja anular y
lo dice.

## Movimiento del día

Cada almacén tiene la pestaña «Movimiento»: cuánto material salió hoy, producto por producto.
Muestra lo vendido (cantidad, unidad y valor), lo que salió por traslado hacia otro almacén —marcado
aparte, porque no es venta— y lo que entró, sea por traslado recibido o por entrada de mercancía.
Se imprime en el papel del almacén y se puede bajar en Excel. Debajo queda el **registro de los
últimos 15 días** (facturas, unidades vendidas y valor por día, con un clic para ver el detalle de
cualquier día). Como la ve el personal, ahí no aparece el costo ni la ganancia.

## Impresión

Cada almacén se configura en hoja carta o en ticket POS térmico (80mm o 58mm) desde
«Almacenes y usuarios», y cada formato tiene su propio diseño:

- **Hoja carta**: una factura normal, pensada para leerse. Arriba el negocio (nombre, dirección,
  teléfono y NIT) y al frente el tipo de documento, el número, la fecha y la hora; después el
  cliente y quién atendió; la tabla de productos con cantidad, valor unitario y valor total; los
  totales a la derecha y la forma de pago a la izquierda; la nota del almacén y, al cerrar, la
  línea para la firma y el sello del vendedor con un mensaje corto al frente («¡Gracias por su
  compra! Conserve esta factura como comprobante…»). No lleva firma del cliente.
  Sin cuadrícula: solo líneas finas que separan los bloques.
- **Ticket POS (80mm / 58mm)**: el formato de tirilla de siempre, sin cambios.

La **forma de pago** sale sola: si el cliente paga con un solo método dice «Efectivo» o
«Transferencia»; si paga con dos o más dice **«Mixto»** y debajo el desglose de cuánto fue por cada
uno (y el cambio, si lo hubo). Los métodos que aparecen en la lista los define cada almacén en
«Mis datos».

La vista previa de la pantalla de venta muestra el documento tal como va a salir. La hoja carta se
ve en grande, a escala de la página real, y la pantalla de venta se ensancha para que quepan las
dos cosas sin apretar nada.

Hoy:

| Almacén | Sede | Impresión |
|---|---|---|
| PVC La 11 | Valledupar | Ticket POS 80mm |
| Techos PVC | Valledupar | Hoja carta |
| Universal Viviana | Valledupar | Hoja carta |
| PVElectricos | Valledupar | Hoja carta |

## Varios usuarios en un mismo almacén

Un almacén puede tener los usuarios que necesite (por ejemplo dos cajas). Todos los usuarios
del mismo almacén comparten **el mismo inventario, el mismo catálogo y la misma numeración de
facturas**, y cada factura queda marcada con el usuario que la hizo. Los inventarios de
almacenes distintos están completamente separados: uno no ve ni afecta los productos del otro.

El cierre de caja es **por almacén y por día**: si hay dos cajas, el cierre suma lo de ambas.

## Sedes / regiones

Un almacén pertenece a una sede (por ejemplo Valledupar). Desde «Almacenes y usuarios» se
crean sedes nuevas, se crean almacenes asignándoles sede e impresión, y se borran almacenes
(escribiendo su nombre exacto como confirmación, porque se borra con todas sus facturas,
productos y gastos). Los reportes de la jefa agrupan por sede.

## Cómo se calcula la ganancia

En «Costos» la administración elige un almacén y define el precio de costo de cada producto.
Al guardar una factura, el sistema toma ese costo y lo guarda como una foto dentro de la
factura, así que cambiar el costo después no altera las facturas viejas.

Se muestran dos cifras, ambas solo para admin/jefa:

    ganancia bruta = (lo cobrado sin IVA y ya con el descuento) − (costo de la mercancía vendida)
    ganancia neta  = ganancia bruta − gastos del período

La **bruta** dice si se está vendiendo con buen margen; la **neta** es lo que realmente queda.

## Reparar (precios invertidos y ganancia vieja)

Como el costo queda congelado dentro de cada factura, cambiar el catálogo hoy no arregla lo ya
vendido. La pestaña «Reparar» (admin/jefa) sí toca las facturas y resuelve los dos casos que se
presentan en la práctica:

1. **Precios invertidos**: lista los productos cuyo costo quedó por encima del precio de venta
   —la señal de que el Excel traía las dos columnas cambiadas—, intercambia los dos valores en los
   que se marquen y vuelve a calcular las facturas donde se vendieron.
2. **Ganancia de facturas hechas antes de poner el costo**: vuelve a tomar el precio de costo que
   hay hoy en «Costos» y recalcula, con filtro opcional de almacén y de fecha «desde».

Lo que se cobró no se toca nunca: el total de cada factura sigue siendo el que pagó el cliente.
Solo cambian el costo y la ganancia, que son cifras internas.

La vista previa no es una estimación: el cambio se ejecuta de verdad dentro de una transacción, se
mide el resultado y se deshace con `ROLLBACK`. Lo que muestra la pantalla es exactamente lo que
queda al confirmar.

Para que no vuelva a pasar, al revisar un Excel el sistema avisa si el costo viene por encima de la
venta y ofrece una casilla para enderezar las dos columnas antes de guardar.

## Subir inventario desde Excel

Hay dos puertas al mismo mecanismo:

- **El almacén**, desde «Productos»: descarga su inventario tal como está hoy (nombre, unidad,
  precio de venta, existencias), lo llena en Excel y lo sube. Su archivo **no trae el precio de
  costo**, y si alguien le agrega esa columna a mano, se ignora: el costo no se puede ver ni
  cambiar desde el almacén.
- **Admin/jefa**, desde «Subir Excel»: lo mismo para cualquier almacén y **con costos**, más la
  plantilla de ejemplo.

En «Subir Excel» (admin/jefa) se cargan muchos productos de una vez a cualquier almacén.
Acepta .xlsx, .xls y .csv, con los encabezados en la primera fila. Solo `nombre` es
obligatorio; reconoce también nombres parecidos («producto», «costo», «cantidad», «stock»)
y entiende precios escritos como `27.000` o `$ 27.000`. Antes de guardar muestra una vista
previa con qué se crea y qué se actualiza, y permite elegir si las existencias del archivo
**reemplazan** o se **suman** a las actuales. Hay una plantilla de ejemplo descargable.

## Claves de usuario

Las claves las escribe quien administra (mínimo 4 caracteres); el sistema no las genera al
azar. Desde «Almacenes y usuarios» se crea un usuario con su clave y se le puede poner una
clave nueva en cualquier momento.

### Si te quedas por fuera (nadie puede entrar como administrador)

1. En Railway, en el servicio, crea la variable **`CLAVE_ADMIN`** con la clave que quieras
   (o `CLAVE_JEFA` para el usuario de la jefa).
2. Railway vuelve a desplegar solo. Al arrancar, esa clave queda puesta y en los registros
   aparece `CLAVE RESTABLECIDA...`.
3. Entra con esa clave y **borra la variable** de Railway, para que no quede escrita ahí.

Sin esa variable el sistema no toca ninguna clave existente.

## Zona horaria

Todo se calcula con la hora del negocio (`America/Bogota`, configurable con la variable
`ZONA_HORARIA`), no con la del servidor. Esto importa: el servidor corre en UTC, así que sin
esto una venta hecha a las 8 de la noche quedaría registrada al día siguiente y el cierre de
caja de esa noche saldría vacío.

## Velocidad

- Las páginas se envían comprimidas (gzip): pesan ~60% menos.
- El CSS y el JavaScript se guardan en el navegador por 30 días y llevan un número de versión
  en la dirección (`estilo.css?v=...`), así que **solo se descargan una vez** y al publicar una
  versión nueva el navegador la toma sin que nadie tenga que borrar caché. Navegar entre
  pestañas pasó de 4 peticiones de red a 1.
- Los reportes mensuales filtran por rango de fechas (usan el índice de la base de datos) en
  vez de convertir cada fila a texto.

## Estructura del proyecto

```
src/
  server.js                       servidor (Express)
  lib/calculos.js                  totales, IVA y fórmulas de m²
  lib/impresion.js                 reglas de papel (carta / 80mm / 58mm)
  lib/inventario.js                cargar inventario desde Excel (con o sin costos)
  lib/reparar.js                   arreglo de precios invertidos y recálculo de facturas
  lib/traslados.js                 mercancía que pasa de un almacén a otro
  lib/movimiento.js                material vendido, trasladado y recibido en el día
  db/schema.sql                    estructura de la base de datos (Postgres)
  db/migrate.js                     crea/actualiza las tablas
  db/actualizar_valledupar.js       puesta a punto de los 4 almacenes (segura de repetir)
  db/seed.js                        usuarios iniciales
  routes/auth.js                    login / logout
  routes/almacen.js                 facturar, cotizar, productos, caja, impresión
  routes/jefa.js                    consolidado, reportes, costos, administración
  views/partials/factura.ejs        factura en hoja carta
  views/partials/ticket.ejs         factura en tirilla POS
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
