// Registro de herramientas: toma los exports de oc.ts, los nombra oc_<export>,
// valida los argumentos con zod antes de ejecutar y registra cada llamada en out/log.jsonl.
import { z } from "zod";
import { registrarLlamada } from "../registro.js";
import * as oc from "./oc.js";
import type { Ctx } from "./oc.js";

interface DefinicionTool {
  description: string;
  args: z.ZodRawShape;
  execute(args: never, ctx: Ctx): Promise<string>;
}

const definiciones: Record<string, DefinicionTool> = Object.fromEntries(
  Object.entries(oc as Record<string, unknown>)
    .filter((par): par is [string, DefinicionTool] => typeof (par[1] as DefinicionTool)?.execute === "function")
    .map(([nombre, def]) => [`oc_${nombre}`, def]),
);

export const nombresHerramientas = Object.keys(definiciones);

/** Formato neutral (nombre, descripción, JSON Schema) que el adaptador LLM traduce a su proveedor. */
export function esquemasHerramientas() {
  return Object.entries(definiciones).map(([nombre, def]) => {
    const { $schema: _omitido, ...esquema } = z.toJSONSchema(z.object(def.args)) as Record<string, unknown>;
    return { nombre, descripcion: def.description, esquema };
  });
}

/** Valida y ejecuta una herramienta. Siempre devuelve el string JSON { ok, data | error }. */
export async function ejecutarHerramienta(nombre: string, args: unknown, ctx: Ctx): Promise<string> {
  const def = definiciones[nombre];
  let resultado: string;
  if (!def) resultado = JSON.stringify({ ok: false, error: `Herramienta desconocida: ${nombre}` });
  else {
    const parsed = z.object(def.args).safeParse(args ?? {});
    resultado = parsed.success
      ? await def.execute(parsed.data as never, ctx)
      : JSON.stringify({ ok: false, error: `Argumentos inválidos: ${z.prettifyError(parsed.error)}` });
  }
  const r = JSON.parse(resultado) as { ok: boolean; error?: string };
  registrarLlamada(ctx.directory, { sessionId: ctx.sessionId, herramienta: nombre, args, ok: r.ok, error: r.error });
  return resultado;
}
