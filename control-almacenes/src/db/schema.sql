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

-- Catálogo de materiales por almacén: precio de costo (lo que cuesta) y precio de venta
CREATE TABLE IF NOT EXISTS materiales (
  id SERIAL PRIMARY KEY,
  almacen_id INTEGER NOT NULL REFERENCES almacenes(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL,
  unidad TEXT NOT NULL DEFAULT 'unidad',
  precio_costo NUMERIC(14,2) NOT NULL DEFAULT 0,
  precio_venta NUMERIC(14,2) NOT NULL DEFAULT 0,
  activo BOOLEAN NOT NULL DEFAULT true,
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (almacen_id, nombre)
);

-- Ventas diarias. Se guarda una "foto" del precio de costo y venta al momento
-- de vender, para que el margen histórico no cambie si luego se actualiza el precio del material.
CREATE TABLE IF NOT EXISTS ventas (
  id SERIAL PRIMARY KEY,
  almacen_id INTEGER NOT NULL REFERENCES almacenes(id) ON DELETE CASCADE,
  material_id INTEGER REFERENCES materiales(id) ON DELETE SET NULL,
  fecha DATE NOT NULL DEFAULT CURRENT_DATE,
  descripcion TEXT NOT NULL,
  cantidad NUMERIC(14,3) NOT NULL,
  precio_costo_unit NUMERIC(14,2) NOT NULL,
  precio_venta_unit NUMERIC(14,2) NOT NULL,
  total_costo NUMERIC(14,2) NOT NULL,
  total_venta NUMERIC(14,2) NOT NULL,
  margen NUMERIC(14,2) NOT NULL,
  registrado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
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

CREATE INDEX IF NOT EXISTS idx_ventas_almacen_fecha ON ventas (almacen_id, fecha);
CREATE INDEX IF NOT EXISTS idx_gastos_almacen_fecha ON gastos (almacen_id, fecha);
CREATE INDEX IF NOT EXISTS idx_materiales_almacen ON materiales (almacen_id);
CREATE INDEX IF NOT EXISTS idx_almacenes_region ON almacenes (region_id);
