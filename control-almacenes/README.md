# Control de almacenes — materiales, ventas, gastos y rentabilidad

Sistema web (no una hoja de cálculo) para que cada almacén suba sus precios de material,
registre ventas y gastos del día, y tu jefa vea todo consolidado desde su iPad, en tiempo real,
sin que nadie tenga que descargar ni reenviar archivos.

## Cómo funciona

- **Cada almacén** tiene su propio usuario y clave. Solo ve y sube su propia información.
  - Sube el catálogo de materiales: precio de costo (lo que le cuesta) y precio de venta.
  - Registra cada venta del día (elige el material y la cantidad; el sistema calcula el margen solo).
  - Registra los gastos del día (arriendo, nómina, transporte, etc.).
- **Tu jefa** tiene un usuario de solo lectura que consolida los 4 almacenes: ve el resumen de hoy
  y un reporte mensual con la **ganancia real total del mes** (la suma de las ventas menos el costo
  del material, sin descontar los gastos) y, aparte, **el total de gastos del mes** — tal como lo pediste.
- **Administrador** (para ti): puede crear almacenes nuevos y usuarios, además de ver todo lo de la jefa.

El margen de cada venta se calcula así: `(precio de venta − precio de costo) × cantidad`.
Ese es el número que ves día a día como "lo que te queda". Los gastos se muestran siempre
en una columna aparte, nunca se restan automáticamente de la ganancia.

## Estructura del proyecto

```
src/
  server.js          servidor principal (Express)
  db/schema.sql       estructura de la base de datos (Postgres)
  db/migrate.js        crea las tablas
  db/seed.js           crea los almacenes y usuarios iniciales
  routes/auth.js        login / logout
  routes/almacen.js     panel del almacén (materiales, ventas, gastos)
  routes/jefa.js         panel consolidado, reporte mensual, administración
  views/                 páginas (EJS)
public/css/estilo.css    estilos
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
     (ej: `Almacén 1,Almacén 2,Almacén 3,Almacén 4`). Solo se usa la primera vez.
4. El `Procfile` ya incluye la migración automática (`release: node src/db/migrate.js`)
   antes de cada despliegue, y el arranque del servidor (`web: node src/server.js`).
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
