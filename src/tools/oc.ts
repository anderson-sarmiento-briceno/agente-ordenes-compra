// Herramientas del agente (contrato de la sección 6.2 del PRD).
// Cada export es { description, args (esquemas zod), execute(args, ctx) } y el modelo la ve como oc_<export>.
// execute devuelve SIEMPRE un string JSON { ok: true, data } o { ok: false, error }. Nunca lanza.
import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { validar as aplicarReglas } from "../controles.js";
import { cargarMaestros, leerPaquete } from "../datos.js";
import { calcularEvidencia, generarEvidencia } from "../evidencia.js";
import { construirPayload } from "../payload.js";
import { registrarControl, rutaOut } from "../registro.js";
import { SapMock } from "../sap/mock.js";

export interface Ctx {
  directory: string; // raíz del proyecto; las rutas se resuelven desde aquí
  sessionId: string;
}

const respuesta = {
  ok: (data: unknown) => JSON.stringify({ ok: true, data }),
  error: (error: string) => JSON.stringify({ ok: false, error }),
};

/** Ejecuta la lógica y convierte cualquier excepción en { ok: false, error } legible. */
async function seguro(fn: () => Promise<unknown> | unknown): Promise<string> {
  try {
    return respuesta.ok(await fn());
  } catch (e) {
    return respuesta.error(e instanceof Error ? e.message : String(e));
  }
}

const caso = z.string().describe('Carpeta del caso en fixtures/reto-03/solicitudes/, por ejemplo "sol-001"');
const ignorado = (que: string) =>
  z.unknown().optional().describe(`Opcional. Se ignora: ${que} se recalcula desde las fuentes para que no pueda alterarse.`);

/** Paquete + maestros + validación: el punto de partida de casi todas las herramientas. */
function evaluar(raiz: string, c: string) {
  const paquete = leerPaquete(raiz, c);
  const maestros = cargarMaestros(raiz);
  return { paquete, maestros, validacion: aplicarReglas(paquete, maestros) };
}

export const leer_paquete = {
  description: "Lee el correo, la solicitud, la cotización, la aprobación y la factura (si existe) de un caso y los devuelve normalizados.",
  args: { caso },
  execute: (args: { caso: string }, ctx: Ctx) => seguro(() => leerPaquete(ctx.directory, args.caso)),
};

export const validar = {
  description: "Aplica las reglas de control RC1–RC10 a un caso y devuelve apta, bloqueos, confirmaciones, derivados y si es retroactiva.",
  args: { caso, paquete: ignorado("el paquete") },
  execute: (args: { caso: string }, ctx: Ctx) =>
    seguro(() => {
      const { validacion } = evaluar(ctx.directory, args.caso);
      return validacion;
    }),
};

export const construir_payload = {
  description: "Construye la OC tal como quedaría en SAP (sin crearla) y guarda la trazabilidad de cada campo en out/<caso>/trazabilidad.json.",
  args: { caso, paquete: ignorado("el paquete"), derivados: ignorado("los derivados") },
  execute: (args: { caso: string }, ctx: Ctx) =>
    seguro(() => {
      const { paquete, maestros, validacion } = evaluar(ctx.directory, args.caso);
      const { sha256 } = calcularEvidencia(ctx.directory, args.caso);
      const { orden, trazabilidad } = construirPayload(paquete, validacion, maestros, sha256, null);
      mkdirSync(rutaOut(ctx.directory, args.caso), { recursive: true });
      writeFileSync(rutaOut(ctx.directory, args.caso, "trazabilidad.json"), JSON.stringify(trazabilidad, null, 2));
      return { orden, trazabilidad: `out/${args.caso}/trazabilidad.json`, confirmaciones_pendientes: validacion.confirmaciones };
    }),
};

export const generar_evidencia = {
  description: "Genera la evidencia del correo de aprobación en out/<caso>/aprobacion.txt y devuelve su ruta y sha256.",
  args: { caso },
  execute: (args: { caso: string }, ctx: Ctx) => seguro(() => generarEvidencia(ctx.directory, args.caso)),
};

/** JSON con llaves ordenadas: permite comparar objetos sin importar el orden de los campos. */
function canonico(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonico).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonico(x)}`).join(",")}}`;
  return JSON.stringify(v);
}

export const crear = {
  description:
    "Crea la OC en SAP. Solo procede si el caso está apto y, cuando hay confirmaciones, con confirmado=true tras la confirmación explícita del usuario. Es idempotente.",
  args: {
    caso,
    payload: z.unknown().optional().describe("Opcional. Si se envía, debe coincidir con el construido desde las fuentes; si no, se rechaza."),
    confirmado: z.boolean().optional().describe("true solo si el usuario confirmó explícitamente en su último mensaje."),
  },
  execute: (args: { caso: string; payload?: unknown; confirmado?: boolean }, ctx: Ctx) =>
    seguro(async () => {
      const raiz = ctx.directory;
      const { paquete, maestros, validacion } = evaluar(raiz, args.caso);
      const sap = new SapMock(raiz);
      const id = paquete.solicitud.solicitud_id;
      const fila = {
        solicitud_id: id,
        retroactiva: validacion.retroactiva,
        bloqueos: validacion.bloqueos.map((b) => b.regla),
        confirmaciones: validacion.confirmaciones.map((c) => c.regla),
      };

      // 1. Idempotencia: si ya existe una OC para esta solicitud, se devuelve la misma.
      const existente = await sap.buscarOrdenPorReferencia(id);
      if (existente) {
        registrarControl(raiz, { ...fila, resultado: "idempotente", numero_oc: existente.numero_oc });
        const previa = sap.listar().find((o) => o.numero_oc === existente.numero_oc);
        return { numero_oc: existente.numero_oc, fecha: previa?.fecha ?? "", idempotente: true };
      }
      // 2. Bloqueos: no se crea nunca.
      if (!validacion.apta) {
        registrarControl(raiz, { ...fila, resultado: "bloqueada", numero_oc: "" });
        throw new Error(`OC bloqueada: ${validacion.bloqueos.map((b) => `${b.regla} ${b.detalle} Acción: ${b.accion}`).join(" | ")}`);
      }
      // 3. Confirmaciones: solo con confirmado = true.
      if (validacion.confirmaciones.length > 0 && args.confirmado !== true) {
        registrarControl(raiz, { ...fila, resultado: "pendiente", numero_oc: "" });
        throw new Error(
          `Requiere confirmación humana antes de crear: ${validacion.confirmaciones.map((c) => `${c.regla} ${c.detalle}`).join(" | ")}`,
        );
      }
      // 4. El payload se reconstruye desde las fuentes; el del modelo solo se acepta si es idéntico.
      const evidencia = generarEvidencia(raiz, args.caso);
      const confirmadoPor = validacion.confirmaciones.length > 0 ? `usuario (sesión ${ctx.sessionId})` : null;
      const { orden } = construirPayload(paquete, validacion, maestros, evidencia.sha256, confirmadoPor);
      const sinExcepciones = (o: unknown) => (o && typeof o === "object" ? { ...o, excepciones: undefined } : o);
      if (args.payload !== undefined && canonico(sinExcepciones(args.payload)) !== canonico(sinExcepciones(orden))) {
        registrarControl(raiz, { ...fila, resultado: "rechazada", numero_oc: "" });
        throw new Error("El payload recibido no coincide con el construido desde las fuentes. Llama oc_crear sin payload.");
      }
      // 5. Crear en SAP y registrar en el log de control.
      const { numero_oc, fecha } = await sap.crearOrden(orden);
      registrarControl(raiz, { ...fila, resultado: "creada", numero_oc });
      return { numero_oc, fecha, idempotente: false, retroactiva: validacion.retroactiva, evidencia: evidencia.ruta };
    }),
};
