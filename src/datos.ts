// Lectura y normalización de los fixtures (maestros + paquete de cada solicitud).
// Cada JSON se valida con zod: si un archivo no tiene la forma esperada, el error dice qué campo falla.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const rutaFixtures = (raiz: string) => join(raiz, "fixtures", "reto-03");
export const rutaMaestros = (raiz: string) => join(rutaFixtures(raiz), "maestros");
export const rutaSolicitudes = (raiz: string) => join(rutaFixtures(raiz), "solicitudes");

// ---------- Maestros (sección 7.1 del PRD) ----------

export const ProveedorSchema = z.object({
  codigo_sap: z.string(),
  nit: z.string(),
  nombre: z.string(),
  condiciones_pago_default: z.string(),
  indicador_iva_default: z.string(),
  activo: z.boolean(),
});

export const AprobadorSchema = z.object({ email: z.string(), nombre: z.string(), tope: z.number() });

export const CentroCostoSchema = z.object({
  centro_costo: z.string(),
  nombre: z.string(),
  subareas: z.array(z.string()),
  aprobadores: z.array(AprobadorSchema),
});

export const IndicadorIvaSchema = z.object({ codigo: z.string(), descripcion: z.string(), tasa: z.number() });
export const CondicionPagoSchema = z.object({ codigo: z.string(), descripcion: z.string(), dias: z.number() });

// ---------- Archivos de cada solicitud ----------

export const CorreoSchema = z.object({
  id: z.string(),
  de: z.string(),
  para: z.string(),
  asunto: z.string(),
  fecha: z.string(),
  cuerpo: z.string(),
  adjuntos: z.array(z.string()),
  nota_fixture: z.string().optional(),
});

export const SolicitudSchema = z.object({
  solicitud_id: z.string(),
  solicitante: z.string(),
  proveedor_nombre: z.string(),
  proveedor_nit: z.string().optional(),
  descripcion: z.string(),
  centro_costo: z.string(),
  subarea: z.string(),
  cantidad: z.number(),
  valor_unitario: z.number(),
  valor_total: z.number(),
  moneda: z.enum(["COP", "USD"]),
  indicador_iva: z.string().optional(),
  condiciones_pago: z.string().optional(),
  fecha_solicitud: z.string(),
});

export const AprobacionArchivoSchema = z.object({
  de: z.string(),
  para: z.string(),
  cc: z.array(z.string()).optional(),
  fecha: z.string(),
  asunto: z.string(),
  cuerpo: z.string(),
});

export type Proveedor = z.infer<typeof ProveedorSchema>;
export type CentroCosto = z.infer<typeof CentroCostoSchema>;
export type Solicitud = z.infer<typeof SolicitudSchema>;
export type AprobacionArchivo = z.infer<typeof AprobacionArchivoSchema>;

export interface Maestros {
  proveedores: Proveedor[];
  centrosCosto: CentroCosto[];
  indicadoresIva: z.infer<typeof IndicadorIvaSchema>[];
  condicionesPago: z.infer<typeof CondicionPagoSchema>[];
}

/** Paquete normalizado (sección 7.2 del PRD). Un adjunto ausente queda en null y se lista en `faltantes`. */
export interface Paquete {
  caso: string;
  correo: { id: string; de: string; asunto: string; fecha: string };
  solicitud: Solicitud;
  cotizacion: {
    numero: string | null;
    proveedor: string;
    nit: string | null;
    total: number;
    moneda: string;
    validez_hasta: string | null;
    texto: string;
  } | null;
  aprobacion: { de: string; fecha: string; aprobado: boolean; texto: string } | null;
  factura: { numero: string; fecha: string; total: number } | null;
  faltantes: string[];
}

// ---------- Utilidades ----------

/** Lee texto quitando el BOM (marca invisible que agregan algunos editores de Windows). */
export function leerTexto(ruta: string): string {
  return readFileSync(ruta, "utf8").replace(/^﻿/, "");
}

function leerJson<T>(ruta: string, esquema: z.ZodType<T>): T {
  const nombre = ruta.split(/[\\/]/).slice(-2).join("/");
  let datos: unknown;
  try {
    datos = JSON.parse(leerTexto(ruta));
  } catch {
    throw new Error(`${nombre} no es un JSON válido`);
  }
  const r = esquema.safeParse(datos);
  if (!r.success) throw new Error(`${nombre} tiene datos inválidos: ${z.prettifyError(r.error)}`);
  return r.data;
}

/** "900.555.111-2" -> "900555111" (sin puntos ni dígito de verificación). */
export const normalizarNit = (nit: string) => nit.split("-")[0].replace(/\D/g, "");

/** "TecnoSuministros S.A.S." -> "tecnosuministros sas" (para comparar nombres). */
export const normalizarNombre = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

/** "COP 11.400.000" -> 11400000 (formato colombiano: punto de miles, coma decimal). */
export const parsearMonto = (s: string) => Number(s.replace(/[^\d,]/g, "").replace(",", "."));

const buscar = (texto: string, patron: RegExp) => texto.match(patron)?.[1]?.trim() ?? null;

function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

// ---------- Lectura ----------

export function cargarMaestros(raiz: string): Maestros {
  const dir = rutaMaestros(raiz);
  return {
    proveedores: leerJson(join(dir, "proveedores.json"), z.array(ProveedorSchema)),
    centrosCosto: leerJson(join(dir, "centros-costo.json"), z.array(CentroCostoSchema)),
    indicadoresIva: leerJson(join(dir, "indicadores-iva.json"), z.array(IndicadorIvaSchema)),
    condicionesPago: leerJson(join(dir, "condiciones-pago.json"), z.array(CondicionPagoSchema)),
  };
}

export function listarCasos(raiz: string): string[] {
  return readdirSync(rutaSolicitudes(raiz), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/** Ruta de la carpeta del caso. Solo acepta nombres tipo "sol-001" (evita rutas como "../../"). */
export function rutaCaso(raiz: string, caso: string): string {
  if (!/^sol-\d{3}$/.test(caso)) throw new Error(`Caso inválido "${caso}": debe tener la forma sol-001`);
  const dir = join(rutaSolicitudes(raiz), caso);
  if (!existsSync(dir)) throw new Error(`No existe el caso ${caso}`);
  return dir;
}

export function leerAprobacionArchivo(raiz: string, caso: string): AprobacionArchivo | null {
  const ruta = join(rutaCaso(raiz, caso), "aprobacion.json");
  return existsSync(ruta) ? leerJson(ruta, AprobacionArchivoSchema) : null;
}

function normalizarCotizacion(texto: string): Paquete["cotizacion"] {
  const total = buscar(texto, /^TOTAL\b[^:\n]*:\s*(?:[A-Z]{3}\s*)?([\d.,]+)/m);
  if (total === null) return null;
  const fecha = buscar(texto, /^Fecha:\s*(\d{4}-\d{2}-\d{2})/m);
  const dias = buscar(texto, /Validez de la oferta:\s*(\d+)\s*d[ií]as/i);
  const nit = buscar(texto, /^NIT:\s*([\d.\-]+)/m);
  return {
    numero: buscar(texto, /COTIZACI[ÓO]N\s+(\S+)/i),
    proveedor: buscar(texto, /^Proveedor:\s*(.+)$/m) ?? "",
    nit: nit ? normalizarNit(nit) : null,
    total: parsearMonto(total),
    moneda: buscar(texto, /^TOTAL\b[^:\n]*:\s*([A-Z]{3})/m) ?? "COP",
    validez_hasta: fecha && dias ? sumarDias(fecha, Number(dias)) : null,
    texto,
  };
}

function normalizarFactura(texto: string): Paquete["factura"] {
  const fecha = buscar(texto, /^Fecha[^:\n]*:\s*(\d{4}-\d{2}-\d{2})/im);
  const total = buscar(texto, /^TOTAL\b[^:\n]*:\s*(?:[A-Z]{3}\s*)?([\d.,]+)/m);
  if (!fecha || !total) return null;
  return { numero: buscar(texto, /No\.\s*(\S+)/) ?? "sin número", fecha, total: parsearMonto(total) };
}

/** Lee y normaliza el paquete completo de un caso. Lanza error solo si falta lo imprescindible. */
export function leerPaquete(raiz: string, caso: string): Paquete {
  const dir = rutaCaso(raiz, caso);
  const faltantes: string[] = [];
  const opcional = (archivo: string) => {
    const ruta = join(dir, archivo);
    if (existsSync(ruta)) return leerTexto(ruta);
    faltantes.push(archivo);
    return null;
  };

  if (!existsSync(join(dir, "solicitud.json"))) throw new Error(`Paquete incompleto: falta solicitud.json en ${caso}`);
  if (!existsSync(join(dir, "correo.json"))) throw new Error(`Paquete incompleto: falta correo.json en ${caso}`);
  const correo = leerJson(join(dir, "correo.json"), CorreoSchema);
  const solicitud = leerJson(join(dir, "solicitud.json"), SolicitudSchema);

  const textoCotizacion = opcional("cotizacion.txt");
  const cotizacion = textoCotizacion ? normalizarCotizacion(textoCotizacion) : null;
  if (textoCotizacion && !cotizacion) faltantes.push("cotizacion.txt (no se encontró el TOTAL)");

  const ap = leerAprobacionArchivo(raiz, caso);
  if (!ap) faltantes.push("aprobacion.json");
  const aprobacion = ap
    ? { de: ap.de, fecha: ap.fecha, aprobado: /\baprobado\b/i.test(ap.cuerpo) && !/\bno\s+aprobado\b/i.test(ap.cuerpo), texto: ap.cuerpo }
    : null;

  // La factura solo existe en compras retroactivas: su ausencia es normal, no se reporta como faltante.
  const rutaFactura = join(dir, "factura.txt");
  const factura = existsSync(rutaFactura) ? normalizarFactura(leerTexto(rutaFactura)) : null;

  return {
    caso,
    correo: { id: correo.id, de: correo.de, asunto: correo.asunto, fecha: correo.fecha },
    solicitud,
    cotizacion,
    aprobacion,
    factura,
    faltantes,
  };
}
