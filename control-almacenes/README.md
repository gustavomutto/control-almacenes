# Control de almacenes — materiales, ventas, gastos y rentabilidad

Sistema web (no una hoja de cálculo) para que cada almacén suba sus precios de material,
registre ventas y gastos del día, y tu jefa vea todo consolidado desde su iPad, en tiempo real,
sin que nadie tenga que descargar ni reenviar archivos.

## Cómo funciona

- **Cada almacén** tiene su propio usuario y clave. Solo ve y sube su propia información.
  - Sube el catálogo de materiales: precio de costo (lo que le cuesta) y precio de venta.
  - Registra cada venta del día (elige el material y la cantidad; el sistema calcula el margen solo).
  - Registra los gastos del día (arriendo, nómina, transporte, etc.).
- **Tu jefa** tiene un usuario de solo lectura que consolida todos los almacenes, agrupados por
  región: ve el resumen de hoy y un reporte mensual con la **ganancia real total del mes** (la suma
  de las ventas menos el costo del material, sin descontar los gastos) y, aparte, **el total de
  gastos del mes** — tal como lo pediste.
- **Administrador** (para ti): puede crear regiones, almacenes nuevos y usuarios, además de ver
  todo lo de la jefa.

El margen de cada venta se calcula así: `(precio de venta − precio de costo) × cantidad`.
Ese es el número que ves día a día como "lo que te queda". Los gastos se muestran siempre
en una columna aparte, nunca se restan automáticamente de la ganancia.

## Regiones

Un almacén puede pertenecer a una región (ej: Valledupar). En "Mis datos" → "Almacenes y
usuarios" (usuario administrador) puedes crear una región nueva y, al crear un almacén, elegir
a qué región pertenece. Tanto el resumen del día como el reporte mensual de la jefa agrupan los
almacenes por región.

Los 4 almacenes originales ya están renombrados y agrupados en la región **Valledupar**:

| Nombre anterior | Nombre actual |
|---|---|
| Almacén 1 | PVC La 11 |
| Almacén 2 | Techos PVC |
| Almacén 3 | Universal Viviana |
| Almacén 4 | PVElectricos |

Los usuarios de inicio de sesión de cada almacén (`almacen1`, `almacen2`, etc.) no cambiaron,
solo el nombre visible.

## Informes

- **Informe de gastos** (pestaña "Gastos", jefa/administrador): el detalle de cada gasto
  registrado, filtrable por mes, región o almacén, con subtotales por región, por almacén y el
  total general.
- **Mercancía vendida por unidad**: tanto el panel del almacén (del día) como el panel y el
  reporte mensual de la jefa muestran cuántas unidades de cada material se vendieron, no solo
  el valor en dinero.

## Estructura del proyecto

```
src/
  server.js                      servidor principal (Express)
  db/schema.sql                   estructura de la base de datos (Postgres)
  db/migrate.js                    crea las tablas
  db/actualizar_valledupar.js       renombra los 4 almacenes iniciales y crea la región Valledupar (seguro de correr varias veces)
  db/seed.js                        crea los almacenes y usuarios iniciales
  routes/auth.js                    login / logout
  routes/almacen.js                 panel del almacén (materiales, ventas, gastos, unidades vendidas)
  routes/jefa.js                     panel consolidado por región, reporte mensual, informe de gastos, administración
  views/                             páginas (EJS)
public/css/estilo.css                estilos
```

## Desplegar en Railway (recomendado — así tu jefa lo ve desde el iPad)

1. Crea un proyecto nuevo en Railway y sube este código (puedes arrastrar la carpeta,
   conectar un repositorio de GitHub, o usar el CLI de Railway: `railway up`).
2. Agrega un plugin de **PostgreSQL** al proyecto (botón "New" → "Database" → "PostgreSQL").
   Railway conecta automáticamente la variable `DATABASE_URL` al servicio web.
3. En las variables del servicio web, agrega:
   - `SESSION_SECRET`: un texto largo y aleatorio (por ejemplo, generado en
     https://1password.com/password-generator o similar).
   - `NODE_ENV=production`
   - Opcional: `SEED_ALMACENES` con los nombres de tus almacenes separados por coma
     (ej: `PVC La 11,Techos PVC,Universal Viviana,PVElectricos`). Solo se usa la primera vez
     que no exista ningún almacén con ese nombre.
4. El `Procfile` ya incluye, antes de cada despliegue: crear las tablas, renombrar/agrupar los
   4 almacenes iniciales en la región Valledupar (no hace nada si ya se aplicó antes), y crear
   los usuarios iniciales si hacen falta. Luego arranca el servidor.
5. Después del primer despliegue, corre una sola vez (desde la pestaña "Shell" del servicio
   en Railway, o con `railway run npm run seed`):
   ```
   npm run seed
   ```
   Esto crea los usuarios de cada almacén, el de la jefa y el de administrador, y te muestra
   las claves generadas **una sola vez** en la terminal — guárdalas de inmediato.
6. Railway te da una URL pública (algo como `tu-proyecto.up.railway.app`). Esa es la dirección
   que tu jefa abre desde el navegador de su iPad (Safari o Chrome), la guarda como acceso
   directo en su pantalla de inicio, y queda como una app.

## Desarrollo local

Requiere Node 18+ y una base de datos Postgres.

```
npm install
cp .env.example .env      # edita DATABASE_URL con tu Postgres local
npm run migrate
npm run seed
npm start
```

Luego abre `http://localhost:3000`.

## Ideas para más adelante (no incluidas todavía)

- Convertirlo en un producto multi-negocio con registro propio y cobro de mensualidad
  (necesitaría aislar los datos por negocio y agregar Stripe u otra pasarela de pago).
- Exportar el reporte mensual a Excel/PDF.
- Gráficas de ventas y rentabilidad por almacén.
