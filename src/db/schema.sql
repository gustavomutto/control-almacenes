-- Esquema: control de materiales, ventas, gastos y rentabilidad por almacén

-- Región: agrupa varios almacenes (ej: Valledupar). Un almacén pertenece a una región (opcional).
CREATE TABLE IF NOT EXISTS regiones (
  id SERIAL PRIMARY KEY,
  nombre TEXT NOT NULL UNIQUE,
  activo BOOLEAN NOT NULL DEFAULT true,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS almacenes (
  id SERIAL PRIMARY KEY,
  nombre TEXT NOT NULL UNIQUE,
  activo BOOLEAN NOT NULL DEFAULT true,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Si la tabla almacenes ya existía de antes (instalaciones previas), le agregamos la columna.
ALTER TABLE almacenes ADD COLUMN IF NOT EXISTS region_id INTEGER REFERENCES regiones(id);

-- Datos que salen impresos en facturas/cotizaciones de cada almacén, y formato de papel.
-- papel: 'carta' (hoja carta), '80mm' o '58mm' (ticket POS térmico).
ALTER TABLE almacenes ADD COLUMN IF NOT EXISTS encabezado TEXT NOT NULL DEFAULT '';
ALTER TABLE almacenes ADD COLUMN IF NOT EXISTS direccion TEXT NOT NULL DEFAULT '';
ALTER TABLE almacenes ADD COLUMN IF NOT EXISTS nit TEXT NOT NULL DEFAULT '';
ALTER TABLE almacenes ADD COLUMN IF NOT EXISTS telefono TEXT NOT NULL DEFAULT '';
ALTER TABLE almacenes ADD COLUMN IF NOT EXISTS nota TEXT NOT NULL DEFAULT '';
ALTER TABLE almacenes ADD COLUMN IF NOT EXISTS papel TEXT NOT NULL DEFAULT 'carta';
ALTER TABLE almacenes ADD COLUMN IF NOT EXISTS metodos_pago TEXT NOT NULL DEFAULT 'Efectivo,Transferencia';
ALTER TABLE almacenes ADD COLUMN IF NOT EXISTS iva_por_defecto BOOLEAN NOT NULL DEFAULT false;

-- rol: 'almacen' (personal de un almacén, solo ve/edita el suyo)
--      'jefa'    (ve el consolidado de todos los almacenes, solo lectura)
--      'admin'   (como jefa, y además puede crear almacenes/usuarios)
CREATE TABLE IF NOT EXISTS usuarios (
  id SERIAL PRIMARY KEY,
  almacen_id INTEGER REFERENCES almacenes(id) ON DELETE CASCADE,
  usuario TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  nombre TEXT NOT NULL,
  rol TEXT NOT NULL CHECK (rol IN ('almacen','jefa','admin')),
  activo BOOLEAN NOT NULL DEFAULT true,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rol_almacen_coherente CHECK (
    (rol = 'almacen' AND almacen_id IS NOT NULL) OR
    (rol IN ('jefa','admin') AND almacen_id IS NULL)
  )
);

-- Gastos del almacén (arriendo, nómina, servicios, transporte, etc.)
-- Se muestran aparte de la ganancia bruta, sin restarse automáticamente.
CREATE TABLE IF NOT EXISTS gastos (
  id SERIAL PRIMARY KEY,
  almacen_id INTEGER NOT NULL REFERENCES almacenes(id) ON DELETE CASCADE,
  fecha DATE NOT NULL DEFAULT CURRENT_DATE,
  concepto TEXT NOT NULL,
  categoria TEXT,
  valor NUMERIC(14,2) NOT NULL,
  registrado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Facturación por almacén
-- ============================================================

-- Catálogo/inventario de cada almacén.
--   precio_venta  = precio sugerido (el vendedor puede cambiarlo al facturar)
--   precio_costo  = lo que costó la mercancía. SOLO lo ven y lo editan admin/jefa.
--   existencias   = cantidad disponible; baja sola al facturar.
CREATE TABLE IF NOT EXISTS productos (
  id SERIAL PRIMARY KEY,
  almacen_id INTEGER NOT NULL REFERENCES almacenes(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL,
  unidad TEXT NOT NULL DEFAULT 'unidad',
  precio_venta NUMERIC(14,2) NOT NULL DEFAULT 0,
  precio_costo NUMERIC(14,2) NOT NULL DEFAULT 0,
  existencias NUMERIC(14,3) NOT NULL DEFAULT 0,
  controla_stock BOOLEAN NOT NULL DEFAULT true,
  activo BOOLEAN NOT NULL DEFAULT true,
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (almacen_id, nombre)
);

-- Facturas y cotizaciones. El consecutivo es propio de cada almacén.
CREATE TABLE IF NOT EXISTS documentos (
  id SERIAL PRIMARY KEY,
  almacen_id INTEGER NOT NULL REFERENCES almacenes(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('factura','cotizacion')),
  numero INTEGER NOT NULL,
  fecha DATE NOT NULL DEFAULT CURRENT_DATE,
  cliente TEXT NOT NULL DEFAULT '',
  m2 NUMERIC(14,3),
  subtotal NUMERIC(14,2) NOT NULL DEFAULT 0,
  descuento NUMERIC(14,2) NOT NULL DEFAULT 0,
  iva NUMERIC(14,2) NOT NULL DEFAULT 0,
  total NUMERIC(14,2) NOT NULL DEFAULT 0,
  -- Costo y margen: se guardan como "foto" al momento de facturar.
  -- Solo se muestran a admin/jefa; el personal del almacén nunca los ve.
  costo_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  margen NUMERIC(14,2) NOT NULL DEFAULT 0,
  cambio NUMERIC(14,2) NOT NULL DEFAULT 0,
  anulada BOOLEAN NOT NULL DEFAULT false,
  registrado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (almacen_id, tipo, numero)
);

CREATE TABLE IF NOT EXISTS documento_items (
  id SERIAL PRIMARY KEY,
  documento_id INTEGER NOT NULL REFERENCES documentos(id) ON DELETE CASCADE,
  producto_id INTEGER REFERENCES productos(id) ON DELETE SET NULL,
  descripcion TEXT NOT NULL,
  detalle TEXT,
  cantidad NUMERIC(14,3) NOT NULL,
  precio_unit NUMERIC(14,2) NOT NULL,
  costo_unit NUMERIC(14,2) NOT NULL DEFAULT 0,
  total NUMERIC(14,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS documento_pagos (
  id SERIAL PRIMARY KEY,
  documento_id INTEGER NOT NULL REFERENCES documentos(id) ON DELETE CASCADE,
  metodo TEXT NOT NULL,
  valor NUMERIC(14,2) NOT NULL
);

-- Entradas de mercancía, salidas por venta y ajustes manuales.
CREATE TABLE IF NOT EXISTS movimientos_inventario (
  id SERIAL PRIMARY KEY,
  producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('entrada','venta','ajuste','anulacion')),
  cantidad NUMERIC(14,3) NOT NULL,
  documento_id INTEGER REFERENCES documentos(id) ON DELETE SET NULL,
  nota TEXT,
  registrado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gastos_almacen_fecha ON gastos (almacen_id, fecha);
CREATE INDEX IF NOT EXISTS idx_almacenes_region ON almacenes (region_id);
CREATE INDEX IF NOT EXISTS idx_productos_almacen ON productos (almacen_id);
CREATE INDEX IF NOT EXISTS idx_documentos_almacen_fecha ON documentos (almacen_id, fecha);
CREATE INDEX IF NOT EXISTS idx_documentos_tipo ON documentos (almacen_id, tipo, numero);
CREATE INDEX IF NOT EXISTS idx_items_documento ON documento_items (documento_id);
CREATE INDEX IF NOT EXISTS idx_pagos_documento ON documento_pagos (documento_id);
