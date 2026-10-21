// Herramientas del agente, tipadas con zod.
// Una misma definición sirve para:
//   1) Decirle a Claude qué herramientas existen (se convierte a JSON Schema).
//   2) Validar lo que Claude envía antes de ejecutar nada.
//   3) Llamarlas directamente desde demo.ts, sin LLM.
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { evaluarSolicitud } from "../controles.js";
import { cargarMaestros, cargarSolicitud, listarIdsSolicitudes } from "../datos.js";
import { sap } from "../sap/simulado.js";

export interface Herramienta {
  nombre: string;
  descripcion: string;
  esquema: z.ZodObject;
  /** Si es true, el agente pausa y pide Aprobar/Rechazar antes de ejecutarla. */
  requiereConfirmacion: boolean;
  ejecutar: (input: unknown) => unknown;
}

export type ResultadoHerramienta = { ok: true; datos: unknown } | { ok: false; error: string };

/** Ayudante: valida la entrada con zod y luego llama a la función con el tipo correcto. */
function definir<S extends z.ZodObject>(h: {
  nombre: string;
  descripcion: string;
  esquema: S;
  requiereConfirmacion?: boolean;
  ejecutar: (input: z.infer<S>) => unknown;
}): Herramienta {
  return {
    ...h,
    requiereConfirmacion: h.requiereConfirmacion ?? false,
    ejecutar: (input) => h.ejecutar(h.esquema.parse(input)),
  };
}

const SolicitudIdInput = z.object({
  solicitudId: z.string().regex(/^sol-\d{3}$/).describe('Id de la solicitud, por ejemplo "sol-001"'),
});

export const herramientas: Herramienta[] = [
  definir({
    nombre: "listar_solicitudes",
    descripcion: "Lista las solicitudes de compra pendientes con un resumen de cada una y si ya tienen OC en SAP.",
    esquema: z.object({}),
    ejecutar: () =>
      listarIdsSolicitudes().map((id) => {
        const exp = cargarSolicitud(id);
        return {
          id,
          asunto: exp.correo.asunto,
          solicitante: exp.solicitud.solicitante,
          nitProveedor: exp.solicitud.nitProveedor,
          tieneFactura: exp.factura !== null,
          ocSap: sap.buscarPorSolicitud(id)?.numero ?? null,
        };
      }),
  }),

  definir({
    nombre: "leer_solicitud",
    descripcion:
      "Devuelve el expediente completo de una solicitud: correo, solicitud, texto de la cotización, aprobación y factura (si existe).",
    esquema: SolicitudIdInput,
    ejecutar: ({ solicitudId }) => cargarSolicitud(solicitudId),
  }),

  definir({
    nombre: "validar_solicitud",
    descripcion:
      "Ejecuta TODOS los controles obligatorios sobre una solicitud y devuelve cada control (OK/FALLA/ALERTA con su explicación), " +
      "si es apta para crear OC y los montos calculados. No modifica nada.",
    esquema: SolicitudIdInput,
    ejecutar: ({ solicitudId }) =>
      evaluarSolicitud(cargarSolicitud(solicitudId), cargarMaestros(), !!sap.buscarPorSolicitud(solicitudId)),
  }),

  definir({
    nombre: "crear_orden_compra",
    descripcion:
      "Crea la orden de compra en SAP para una solicitud. Vuelve a validar todos los controles y se niega si alguno falla. " +
      "Requiere confirmación humana: el usuario verá botones Aprobar/Rechazar.",
    esquema: SolicitudIdInput,
    requiereConfirmacion: true,
    ejecutar: ({ solicitudId }) => {
      // Idempotencia: si ya existe, no se crea otra.
      const existente = sap.buscarPorSolicitud(solicitudId);
      if (existente) return { creada: false, yaExistia: true, oc: existente };

      // La herramienta NO confía en el modelo: valida de nuevo antes de escribir en SAP.
      const evaluacion = evaluarSolicitud(cargarSolicitud(solicitudId), cargarMaestros(), false);
      if (!evaluacion.apta) {
        return {
          creada: false,
          motivo: "La solicitud no pasa los controles obligatorios.",
          controlesFallidos: evaluacion.controles.filter((c) => c.estado === "FALLA"),
        };
      }
      const { oc } = sap.crearOrdenCompra(evaluacion.datosOC);
      return { creada: true, oc };
    },
  }),

  definir({
    nombre: "listar_ordenes_compra",
    descripcion: "Lista las órdenes de compra ya creadas en SAP.",
    esquema: z.object({}),
    ejecutar: () => sap.listar(),
  }),
];

export function buscarHerramienta(nombre: string): Herramienta | undefined {
  return herramientas.find((h) => h.nombre === nombre);
}

/** Ejecuta una herramienta por nombre. Nunca lanza: los errores se devuelven como { ok: false }. */
export function ejecutarHerramienta(nombre: string, input: unknown): ResultadoHerramienta {
  const h = buscarHerramienta(nombre);
  if (!h) return { ok: false, error: `Herramienta desconocida: ${nombre}` };
  try {
    return { ok: true, datos: h.ejecutar(input) };
  } catch (e) {
    const mensaje = e instanceof z.ZodError ? `Entrada inválida: ${z.prettifyError(e)}` : String(e instanceof Error ? e.message : e);
    return { ok: false, error: mensaje };
  }
}

/** Convierte las herramientas zod al formato que espera la API de Claude. */
export function definicionesParaClaude(): Anthropic.Tool[] {
  return herramientas.map((h) => {
    const { $schema: _omitido, ...schema } = z.toJSONSchema(h.esquema) as Record<string, unknown>;
    return {
      name: h.nombre,
      description: h.descripcion,
      input_schema: schema as Anthropic.Tool.InputSchema,
    };
  });
}
