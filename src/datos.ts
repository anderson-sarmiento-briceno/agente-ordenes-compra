// Lectura de los fixtures (maestros + solicitudes).
// Cada JSON se valida con un esquema zod: si el archivo real no tiene la forma
// esperada, zod lanza un error que dice exactamente qué campo falla.
// >>> El día de la prueba, AJUSTAR estos esquemas a los JSON reales del .zip. <<<
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "reto-03");
const DIR_MAESTROS = join(RAIZ, "maestros");
const DIR_SOLICITUDES = join(RAIZ, "solicitudes");

// ---------- Esquemas de los maestros ----------

export const ProveedorSchema = z.object({
  nit: z.string(),
  nombre: z.string(),
  estado: z.string(), // p. ej. "ACTIVO" | "BLOQUEADO"
  condicionPagoDefault: z.string(),
  indicadorIvaDefault: z.string(),
});

export const CentroCostoSchema = z.object({
  codigo: z.string(),
  nombre: z.string(),
  subareas: z.array(z.string()),
  lider: z.object({
    nombre: z.string(),
    email: z.string(),
    topeAprobacion: z.number(),
  }),
});

export const IndicadorIvaSchema = z.object({
  codigo: z.string(),
  descripcion: z.string(),
  tasa: z.number(), // 0.19 = 19 %
});

export const CondicionPagoSchema = z.object({
  codigo: z.string(),
  dias: z.number(),
  descripcion: z.string(),
});

// ---------- Esquemas de cada solicitud ----------

export const CorreoSchema = z.object({
  de: z.string(),
  asunto: z.string(),
  fecha: z.string(),
});

export const ItemSchema = z.object({
  descripcion: z.string(),
  cantidad: z.number(),
  precioUnitario: z.number(),
});

export const SolicitudSchema = z.object({
  id: z.string(),
  fecha: z.string(),
  solicitante: z.string(),
  nitProveedor: z.string(),
  centroCosto: z.string(),
  subarea: z.string(),
  indicadorIva: z.string().optional(),
  condicionPago: z.string().optional(),
  items: z.array(ItemSchema).min(1),
});

export const AprobacionSchema = z.object({
  aprobador: z.string(),
  aprobado: z.boolean(),
  fecha: z.string(),
});

export type Proveedor = z.infer<typeof ProveedorSchema>;
export type CentroCosto = z.infer<typeof CentroCostoSchema>;
export type IndicadorIva = z.infer<typeof IndicadorIvaSchema>;
export type CondicionPago = z.infer<typeof CondicionPagoSchema>;
export type Solicitud = z.infer<typeof SolicitudSchema>;
export type Aprobacion = z.infer<typeof AprobacionSchema>;

export interface Maestros {
  proveedores: Proveedor[];
  centrosCosto: CentroCosto[];
  indicadoresIva: IndicadorIva[];
  condicionesPago: CondicionPago[];
}

/** Todo lo que viene en la carpeta de una solicitud (sol-001, sol-002, ...). */
export interface ExpedienteSolicitud {
  id: string;
  correo: z.infer<typeof CorreoSchema>;
  solicitud: Solicitud;
  cotizacion: string;
  aprobacion: Aprobacion;
  factura: string | null; // solo existe en compras retroactivas
}

// ---------- Funciones de lectura ----------

function leerJson<T>(ruta: string, esquema: z.ZodType<T>): T {
  return esquema.parse(JSON.parse(readFileSync(ruta, "utf8")));
}

export function cargarMaestros(): Maestros {
  return {
    proveedores: leerJson(join(DIR_MAESTROS, "proveedores.json"), z.array(ProveedorSchema)),
    centrosCosto: leerJson(join(DIR_MAESTROS, "centros-costo.json"), z.array(CentroCostoSchema)),
    indicadoresIva: leerJson(join(DIR_MAESTROS, "indicadores-iva.json"), z.array(IndicadorIvaSchema)),
    condicionesPago: leerJson(join(DIR_MAESTROS, "condiciones-pago.json"), z.array(CondicionPagoSchema)),
  };
}

export function listarIdsSolicitudes(): string[] {
  return readdirSync(DIR_SOLICITUDES, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

export function cargarSolicitud(id: string): ExpedienteSolicitud {
  // Solo se aceptan ids con forma "sol-001": evita que alguien pida "../../algo".
  if (!/^sol-\d{3}$/.test(id)) throw new Error(`Id de solicitud inválido: ${id}`);
  const dir = join(DIR_SOLICITUDES, id);
  if (!existsSync(dir)) throw new Error(`No existe la solicitud ${id}`);

  const rutaFactura = join(dir, "factura.txt");
  return {
    id,
    correo: leerJson(join(dir, "correo.json"), CorreoSchema),
    solicitud: leerJson(join(dir, "solicitud.json"), SolicitudSchema),
    cotizacion: readFileSync(join(dir, "cotizacion.txt"), "utf8"),
    aprobacion: leerJson(join(dir, "aprobacion.json"), AprobacionSchema),
    factura: existsSync(rutaFactura) ? readFileSync(rutaFactura, "utf8") : null,
  };
}
