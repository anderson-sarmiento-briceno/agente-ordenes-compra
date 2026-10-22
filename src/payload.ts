// Payload de la OC (sección 7.4 del PRD) y su trazabilidad campo -> fuente.
import { z } from "zod";
import type { Validacion } from "./controles.js";
import { buscarProveedor } from "./controles.js";
import type { Maestros, Paquete } from "./datos.js";

export const OrdenCompraSchema = z.object({
  referencia: z.object({ solicitud_id: z.string(), correo_id: z.string(), cotizacion_ref: z.string().nullable() }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({ codigo_sap: z.string(), nit: z.string(), nombre: z.string() }),
  moneda: z.enum(["COP", "USD"]),
  condiciones_pago: z.string(),
  aprobador: z.object({ email: z.string(), fecha_aprobacion: z.string(), evidencia_sha256: z.string().length(64) }),
  posiciones: z
    .array(
      z.object({
        numero: z.number().int(),
        descripcion: z.string().max(40),
        cantidad: z.number().positive(),
        unidad: z.enum(["UN", "H", "MES"]),
        precio_unitario: z.number().nonnegative(),
        centro_costo: z.string(),
        subarea: z.string(),
        indicador_iva: z.string(),
      }),
    )
    .min(1),
  excepciones: z.array(z.object({ codigo: z.string(), detalle: z.string(), confirmado_por: z.string().nullable() })),
});

export type OrdenCompra = z.infer<typeof OrdenCompraSchema>;
export type Trazabilidad = Record<string, string>;

/** Unidad SAP a partir de la descripción (supuesto documentado en SOLUCION.md). */
function inferirUnidad(descripcion: string): "UN" | "H" | "MES" {
  if (/\bhoras?\b/i.test(descripcion)) return "H";
  if (/\b(mensualidad|por mes)\b/i.test(descripcion)) return "MES";
  return "UN";
}

/**
 * Construye la OC solo con valores salidos de fuentes (solicitud, cotización, maestros o derivados).
 * Lanza error si la validación tiene bloqueos: una OC bloqueada no se arma.
 */
export function construirPayload(
  paquete: Paquete,
  validacion: Validacion,
  maestros: Maestros,
  evidenciaSha256: string,
  confirmadoPor: string | null,
): { orden: OrdenCompra; trazabilidad: Trazabilidad } {
  if (!validacion.apta) throw new Error(`No se puede construir la OC: bloqueos ${validacion.bloqueos.map((b) => b.regla).join(", ")}`);
  const { proveedor } = buscarProveedor(paquete, maestros);
  if (!proveedor || !paquete.aprobacion) throw new Error("No se puede construir la OC: falta proveedor o aprobación");
  const s = paquete.solicitud;
  const d = validacion.derivados;

  const orden = OrdenCompraSchema.parse({
    referencia: { solicitud_id: s.solicitud_id, correo_id: paquete.correo.id, cotizacion_ref: paquete.cotizacion?.numero ?? null },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: { codigo_sap: proveedor.codigo_sap, nit: proveedor.nit, nombre: proveedor.nombre },
    moneda: s.moneda,
    condiciones_pago: s.condiciones_pago ?? d.condiciones_pago.valor,
    aprobador: { email: paquete.aprobacion.de, fecha_aprobacion: paquete.aprobacion.fecha, evidencia_sha256: evidenciaSha256 },
    posiciones: [
      {
        numero: 10,
        descripcion: s.descripcion.slice(0, 40),
        cantidad: s.cantidad,
        unidad: inferirUnidad(s.descripcion),
        precio_unitario: s.valor_unitario,
        centro_costo: s.centro_costo,
        subarea: s.subarea,
        indicador_iva: s.indicador_iva ?? d.indicador_iva.valor,
      },
    ],
    excepciones: validacion.confirmaciones.map((c) => ({ codigo: c.regla, detalle: c.detalle, confirmado_por: confirmadoPor })),
  });

  const trazabilidad: Trazabilidad = {
    "referencia.solicitud_id": "solicitud",
    "referencia.correo_id": "correo",
    "referencia.cotizacion_ref": paquete.cotizacion?.numero ? "cotizacion" : "sin cotización",
    sociedad: "constante (configuración)",
    organizacion_compras: "constante (configuración)",
    "proveedor.codigo_sap": "maestro.proveedores",
    "proveedor.nit": "maestro.proveedores",
    "proveedor.nombre": "maestro.proveedores",
    moneda: "solicitud",
    condiciones_pago: s.condiciones_pago ? "solicitud" : "derivado (maestro.proveedores)",
    "aprobador.email": "aprobacion",
    "aprobador.fecha_aprobacion": "aprobacion",
    "aprobador.evidencia_sha256": "derivado (sha256 de la evidencia)",
    "posiciones[0].descripcion": "solicitud (máx. 40 caracteres)",
    "posiciones[0].cantidad": "solicitud",
    "posiciones[0].unidad": "derivado (inferida de la descripción)",
    "posiciones[0].precio_unitario": "solicitud",
    "posiciones[0].centro_costo": "solicitud",
    "posiciones[0].subarea": "solicitud",
    "posiciones[0].indicador_iva": s.indicador_iva ? "solicitud" : "derivado (maestro.proveedores)",
    excepciones: "validación (RC1–RC10)",
  };
  return { orden, trazabilidad };
}
