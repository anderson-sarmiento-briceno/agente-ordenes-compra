// Ciclo del agente (sección 6.3 del PRD).
//   usuario -> modelo -> ¿pide herramientas? -> ejecutarlas -> devolver resultados -> repetir
//   hasta que el modelo responda solo con texto o se alcance el tope de iteraciones (CA1).
// Confirmación humana (CA3): el turno termina con una pregunta; el backend solo deja pasar
// oc_crear con confirmado=true si el ÚLTIMO mensaje del usuario fue una confirmación.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ErrorProveedorLLM, type Bloque, type MensajeLLM, type ProveedorLLM } from "./llm/adapter.js";
import { crearProveedorLLM } from "./llm/index.js";
import { ejecutarHerramienta, esquemasHerramientas } from "./tools/index.js";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_ITERACIONES = Number(process.env.MAX_ITERACIONES ?? 25);
const MAX_TOKENS_SESION = Number(process.env.MAX_TOKENS_SESION ?? 300000);

// Comportamiento (agent/prompt.md) + conocimiento del proceso (src/knowledge/) = system prompt.
const SISTEMA = [
  readFileSync(join(RAIZ, "agent", "prompt.md"), "utf8"),
  "# Conocimiento del proceso",
  readFileSync(join(RAIZ, "src", "knowledge", "ordenes-compra.md"), "utf8"),
].join("\n\n");
const HERRAMIENTAS = esquemasHerramientas();

let llm: ProveedorLLM | null = null;
export const obtenerLLM = () => (llm ??= crearProveedorLLM());

export interface LlamadaVisible {
  herramienta: string;
  args: unknown;
  ok: boolean;
  resultado: unknown; // data o error, para mostrar en el chat
}

export interface RespuestaChat {
  reply: string;
  toolCalls: LlamadaVisible[];
  needsConfirmation: boolean;
  uso: { tokens: number; costoUsd: number; tokensMax: number };
}

interface Sesion {
  mensajes: MensajeLLM[];
  historial: { rol: "usuario" | "agente"; texto: string; toolCalls?: LlamadaVisible[]; needsConfirmation?: boolean; ts: string }[];
  pendiente: string | null; // caso que espera confirmación del usuario
  confirmado: string | null; // caso que el usuario confirmó en su último mensaje
  tokens: number;
  costoUsd: number;
  ocupada: boolean;
}

const sesiones = new Map<string, Sesion>();

function obtenerSesion(id: string): Sesion {
  let s = sesiones.get(id);
  if (!s) {
    s = { mensajes: [], historial: [], pendiente: null, confirmado: null, tokens: 0, costoUsd: 0, ocupada: false };
    sesiones.set(id, s);
  }
  return s;
}

export const historialSesion = (id: string) => sesiones.get(id)?.historial ?? null;

/** ¿El mensaje del usuario es una confirmación explícita? (determinista, no lo decide el modelo) */
export const esConfirmacion = (texto: string) =>
  /^\s*(s[ií]|confirmo|confirmado|de acuerdo|ok|dale|procede|adelante|apruebo|autorizo)\b/i.test(texto) && !/^\s*no\b/i.test(texto);

export async function procesarMensaje(sessionId: string, mensaje: string): Promise<RespuestaChat> {
  const s = obtenerSesion(sessionId);
  if (s.ocupada) throw new Error("Ya hay una petición en curso en esta sesión.");
  s.ocupada = true;
  try {
    return await turno(s, sessionId, mensaje);
  } finally {
    s.ocupada = false;
  }
}

async function turno(s: Sesion, sessionId: string, mensaje: string): Promise<RespuestaChat> {
  const toolCalls: LlamadaVisible[] = [];
  const textos: string[] = [];
  const responder = (): RespuestaChat => {
    const r: RespuestaChat = {
      reply: textos.join("\n\n"),
      toolCalls,
      needsConfirmation: s.pendiente !== null,
      uso: { tokens: s.tokens, costoUsd: s.costoUsd, tokensMax: MAX_TOKENS_SESION },
    };
    s.historial.push({ rol: "agente", texto: r.reply, toolCalls, needsConfirmation: r.needsConfirmation, ts: new Date().toISOString() });
    return r;
  };

  s.historial.push({ rol: "usuario", texto: mensaje, ts: new Date().toISOString() });
  if (s.tokens >= MAX_TOKENS_SESION) {
    textos.push(`Esta sesión alcanzó el tope de ${MAX_TOKENS_SESION.toLocaleString("es-CO")} tokens. Abre una sesión nueva para continuar.`);
    return responder();
  }

  // La confirmación solo vale para el caso pendiente y solo en el mensaje inmediatamente siguiente.
  s.confirmado = s.pendiente && esConfirmacion(mensaje) ? s.pendiente : null;
  s.pendiente = null;
  s.mensajes.push({ rol: "usuario", bloques: [{ tipo: "texto", texto: mensaje }] });

  for (let i = 0; i < MAX_ITERACIONES; i++) {
    let resp;
    try {
      resp = await obtenerLLM().enviar(SISTEMA, s.mensajes, HERRAMIENTAS);
    } catch (e) {
      // CA5: el error se muestra claro y la sesión sigue viva.
      textos.push(`⚠️ ${e instanceof ErrorProveedorLLM ? e.message : "No se pudo contactar al modelo."}`);
      return responder();
    }
    s.tokens += resp.uso.tokensEntrada + resp.uso.tokensSalida;
    s.costoUsd += resp.uso.costoUsd;
    s.mensajes.push(resp.mensaje);
    for (const b of resp.mensaje.bloques) if (b.tipo === "texto" && b.texto.trim()) textos.push(b.texto);

    if (resp.fin !== "herramientas") {
      if (resp.fin === "rechazo") textos.push("(El modelo declinó responder esta petición.)");
      if (resp.fin === "limite") textos.push("(La respuesta se cortó por longitud.)");
      return responder();
    }

    const resultados: Bloque[] = [];
    for (const b of resp.mensaje.bloques) {
      if (b.tipo !== "llamada") continue;
      const contenido = await ejecutarConGuardas(s, sessionId, b.nombre, b.args);
      const r = JSON.parse(contenido) as { ok: boolean; data?: unknown; error?: string };
      actualizarConfirmacion(s, b.nombre, b.args, r);
      toolCalls.push({ herramienta: b.nombre, args: b.args, ok: r.ok, resultado: r.ok ? r.data : r.error });
      resultados.push({ tipo: "resultado", id: b.id, contenido, esError: !r.ok });
    }
    // Todos los resultados del turno van juntos en un solo mensaje.
    s.mensajes.push({ rol: "usuario", bloques: resultados });
  }

  // CA1: tope de iteraciones alcanzado.
  textos.push(`(Alcancé el tope de ${MAX_ITERACIONES} pasos en este turno. Arriba está lo que alcancé a hacer; pídeme continuar con lo que falte.)`);
  return responder();
}

/** Guarda determinista: el modelo no puede confirmar por su cuenta. */
async function ejecutarConGuardas(s: Sesion, sessionId: string, nombre: string, args: unknown): Promise<string> {
  const a = (args ?? {}) as { caso?: string; confirmado?: boolean };
  if (nombre === "oc_crear" && a.confirmado === true && s.confirmado !== a.caso)
    return JSON.stringify({
      ok: false,
      error: "El usuario aún no ha confirmado esta acción en su último mensaje. Termina el turno preguntándole explícitamente si confirma.",
    });
  return ejecutarHerramienta(nombre, args, { directory: RAIZ, sessionId });
}

/** Marca el caso como pendiente de confirmación según lo que devolvieron las herramientas. */
function actualizarConfirmacion(s: Sesion, nombre: string, args: unknown, r: { ok: boolean; data?: unknown; error?: string }) {
  const caso = (args as { caso?: string } | null)?.caso ?? null;
  if (!caso) return;
  if (nombre === "oc_validar" && r.ok) {
    const v = r.data as { apta: boolean; confirmaciones: unknown[] };
    if (v.apta && v.confirmaciones.length > 0) s.pendiente = caso;
  }
  if (nombre === "oc_crear") {
    if (!r.ok && r.error?.startsWith("Requiere confirmación")) s.pendiente = caso;
    if (r.ok) {
      s.pendiente = null;
      s.confirmado = null;
    }
  }
}
