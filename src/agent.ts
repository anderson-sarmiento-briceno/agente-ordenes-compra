// Ciclo del agente (agent loop).
//   1. Se envía a Claude: system prompt + historial + definición de herramientas.
//   2. Si Claude responde con texto -> se termina el turno.
//   3. Si pide herramientas (tool_use) -> el backend las ejecuta y devuelve tool_result.
//   4. Si una herramienta requiere confirmación humana -> el ciclo se PAUSA
//      y el frontend muestra Aprobar/Rechazar. Al responder, el ciclo continúa.
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buscarHerramienta, definicionesParaClaude, ejecutarHerramienta, type ResultadoHerramienta } from "./tools/oc.js";

const SYSTEM_PROMPT = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "agent", "prompt.md"),
  "utf8",
);
const TOOLS = definicionesParaClaude();
const MAX_VUELTAS = 15; // freno de seguridad contra ciclos infinitos

// Precios de Claude Haiku 5.5 en USD por millón de tokens (prompts de hasta 100K tokens).
const PRECIO_INPUT = 0.1;
const PRECIO_OUTPUT = 0.5;

// El cliente se crea la primera vez que se usa, así el servidor arranca aunque falte la API key.
let cliente: Anthropic | null = null;
const obtenerCliente = () => (cliente ??= new Anthropic());
const modelo = () => process.env.ANTHROPIC_MODEL ?? "claude-haiku-5-5";

export interface EventoHerramienta {
  id: string;
  nombre: string;
  input: unknown;
  estado: "ejecutada" | "pendiente" | "rechazada";
  resultado?: ResultadoHerramienta;
}

export interface RespuestaAgente {
  texto: string;
  herramientas: EventoHerramienta[];
  /** Si no es null, el frontend debe mostrar Aprobar/Rechazar. */
  confirmacion: { id: string; nombre: string; input: unknown }[] | null;
  uso: { inputTokens: number; outputTokens: number; costoUsd: number };
}

interface Sesion {
  mensajes: Anthropic.MessageParam[];
  pendiente: { resultadosListos: Anthropic.ToolResultBlockParam[]; porConfirmar: Anthropic.ToolUseBlock[] } | null;
  ocupada: boolean;
  uso: { inputTokens: number; outputTokens: number; costoUsd: number };
}

// Sesiones en memoria (una por pestaña del navegador). Se pierden al reiniciar el servidor.
const sesiones = new Map<string, Sesion>();

function obtenerSesion(id: string): Sesion {
  let s = sesiones.get(id);
  if (!s) {
    s = { mensajes: [], pendiente: null, ocupada: false, uso: { inputTokens: 0, outputTokens: 0, costoUsd: 0 } };
    sesiones.set(id, s);
  }
  return s;
}

/** Ejecuta una función sobre la sesión impidiendo dos peticiones simultáneas. */
async function conSesion(id: string, fn: (s: Sesion) => Promise<RespuestaAgente>) {
  const s = obtenerSesion(id);
  if (s.ocupada) throw new Error("Ya hay una petición en curso para esta conversación.");
  s.ocupada = true;
  try {
    return await fn(s);
  } finally {
    s.ocupada = false;
  }
}

function resultadoComoBloque(id: string, r: ResultadoHerramienta): Anthropic.ToolResultBlockParam {
  return {
    type: "tool_result",
    tool_use_id: id,
    content: JSON.stringify(r.ok ? r.datos : { error: r.error }),
    is_error: !r.ok,
  };
}

/** Paso 1: el usuario escribe un mensaje. */
export function enviarMensaje(sesionId: string, texto: string) {
  return conSesion(sesionId, async (s) => {
    if (s.pendiente) throw new Error("Primero aprueba o rechaza la acción pendiente.");
    s.mensajes.push({ role: "user", content: texto });
    return ciclo(s, []);
  });
}

/** Paso 6: el usuario pulsa Aprobar o Rechazar. */
export function confirmar(sesionId: string, aprobado: boolean) {
  return conSesion(sesionId, async (s) => {
    if (!s.pendiente) throw new Error("No hay ninguna acción pendiente de confirmar.");
    const { resultadosListos, porConfirmar } = s.pendiente;
    s.pendiente = null;

    const eventos: EventoHerramienta[] = [];
    const resultados = [...resultadosListos];
    for (const tu of porConfirmar) {
      const r: ResultadoHerramienta = aprobado
        ? ejecutarHerramienta(tu.name, tu.input)
        : { ok: false, error: "El usuario RECHAZÓ esta acción. No se ejecutó." };
      eventos.push({ id: tu.id, nombre: tu.name, input: tu.input, estado: aprobado ? "ejecutada" : "rechazada", resultado: r });
      resultados.push(resultadoComoBloque(tu.id, r));
    }
    // Todos los tool_result de un mismo turno van juntos en un solo mensaje "user".
    s.mensajes.push({ role: "user", content: resultados });
    return ciclo(s, eventos);
  });
}

/** Pasos 2 a 5: llama a Claude y ejecuta herramientas hasta que responda solo con texto. */
async function ciclo(s: Sesion, eventos: EventoHerramienta[]): Promise<RespuestaAgente> {
  const textos: string[] = [];
  const responder = (confirmacion: RespuestaAgente["confirmacion"]): RespuestaAgente => ({
    texto: textos.join("\n\n"),
    herramientas: eventos,
    confirmacion,
    uso: { ...s.uso },
  });

  for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
    const resp = await obtenerCliente().messages.create({
      model: modelo(),
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: s.mensajes,
      output_config: { effort: "low" }, // tarea sencilla de enrutar herramientas: menos tokens
      cache_control: { type: "ephemeral" }, // reutiliza el prefijo (prompt + historial) entre vueltas
    });
    contarUso(s, resp.usage);

    // Se guarda la respuesta COMPLETA (texto, tool_use y bloques de razonamiento) en el historial.
    s.mensajes.push({ role: "assistant", content: resp.content });
    for (const b of resp.content) if (b.type === "text" && b.text.trim()) textos.push(b.text);

    if (resp.stop_reason !== "tool_use") {
      if (resp.stop_reason === "refusal") textos.push("(El modelo declinó responder a esta petición.)");
      return responder(null);
    }

    const resultados: Anthropic.ToolResultBlockParam[] = [];
    const porConfirmar: Anthropic.ToolUseBlock[] = [];
    for (const tu of resp.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")) {
      if (buscarHerramienta(tu.name)?.requiereConfirmacion) {
        porConfirmar.push(tu);
        eventos.push({ id: tu.id, nombre: tu.name, input: tu.input, estado: "pendiente" });
      } else {
        const r = ejecutarHerramienta(tu.name, tu.input);
        eventos.push({ id: tu.id, nombre: tu.name, input: tu.input, estado: "ejecutada", resultado: r });
        resultados.push(resultadoComoBloque(tu.id, r));
      }
    }

    if (porConfirmar.length > 0) {
      // PAUSA: se guardan los resultados ya listos y se espera la decisión humana.
      s.pendiente = { resultadosListos: resultados, porConfirmar };
      return responder(porConfirmar.map((tu) => ({ id: tu.id, nombre: tu.name, input: tu.input })));
    }
    s.mensajes.push({ role: "user", content: resultados });
  }

  textos.push("(Se alcanzó el máximo de pasos del agente en este turno.)");
  return responder(null);
}

function contarUso(s: Sesion, u: Anthropic.Usage) {
  const escrituraCache = u.cache_creation_input_tokens ?? 0;
  const lecturaCache = u.cache_read_input_tokens ?? 0;
  s.uso.inputTokens += u.input_tokens + escrituraCache + lecturaCache;
  s.uso.outputTokens += u.output_tokens;
  // Escribir en caché cuesta 1,25x; leer de caché cuesta 0,1x del precio normal de entrada.
  s.uso.costoUsd +=
    ((u.input_tokens + escrituraCache * 1.25 + lecturaCache * 0.1) * PRECIO_INPUT + u.output_tokens * PRECIO_OUTPUT) / 1e6;
}
