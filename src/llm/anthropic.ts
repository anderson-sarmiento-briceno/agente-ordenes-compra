// Implementación de ProveedorLLM para Anthropic (Claude). Traduce los tipos neutrales a los del SDK.
import Anthropic from "@anthropic-ai/sdk";
import { ErrorProveedorLLM, type Bloque, type HerramientaLLM, type MensajeLLM, type ProveedorLLM, type RespuestaLLM } from "./adapter.js";

// Precios de Claude Haiku 5.5 en USD por millón de tokens (prompts de hasta 100K tokens).
const PRECIO_ENTRADA = 0.1;
const PRECIO_SALIDA = 0.5;

export class ProveedorAnthropic implements ProveedorLLM {
  readonly proveedor = "anthropic";
  readonly modelo = process.env.ANTHROPIC_MODEL ?? "claude-haiku-5-5";
  private readonly cliente = new Anthropic({ timeout: Number(process.env.LLM_TIMEOUT_MS ?? 60000), maxRetries: 2 });

  async enviar(sistema: string, mensajes: MensajeLLM[], herramientas: HerramientaLLM[]): Promise<RespuestaLLM> {
    let resp: Anthropic.Message;
    try {
      resp = await this.cliente.messages.create({
        model: this.modelo,
        max_tokens: 8000,
        system: sistema,
        tools: herramientas.map((h) => ({
          name: h.nombre,
          description: h.descripcion,
          input_schema: h.esquema as Anthropic.Tool.InputSchema,
        })),
        messages: mensajes.map(aMensajeAnthropic),
        output_config: { effort: "low" }, // enrutar herramientas y redactar no requiere razonamiento profundo
        cache_control: { type: "ephemeral" }, // reutiliza el prefijo repetido entre vueltas
      });
    } catch (e) {
      throw new ErrorProveedorLLM(traducirError(e));
    }

    const u = resp.usage;
    const lectura = u.cache_read_input_tokens ?? 0;
    const escritura = u.cache_creation_input_tokens ?? 0;
    return {
      mensaje: {
        rol: "asistente",
        nativo: resp.content, // se reenvía tal cual (incluye bloques de razonamiento)
        bloques: resp.content.flatMap((b): Bloque[] =>
          b.type === "text"
            ? [{ tipo: "texto" as const, texto: b.text }]
            : b.type === "tool_use"
              ? [{ tipo: "llamada" as const, id: b.id, nombre: b.name, args: b.input }]
              : [],
        ),
      },
      fin: resp.stop_reason === "tool_use" ? "herramientas" : resp.stop_reason === "refusal" ? "rechazo" : resp.stop_reason === "max_tokens" ? "limite" : "texto",
      uso: {
        tokensEntrada: u.input_tokens + lectura + escritura,
        tokensSalida: u.output_tokens,
        costoUsd: ((u.input_tokens + escritura * 1.25 + lectura * 0.1) * PRECIO_ENTRADA + u.output_tokens * PRECIO_SALIDA) / 1e6,
      },
    };
  }
}

function aMensajeAnthropic(m: MensajeLLM): Anthropic.MessageParam {
  if (m.rol === "asistente") return { role: "assistant", content: (m.nativo as Anthropic.ContentBlock[] | undefined) ?? textoDe(m) };
  const contenido: Anthropic.ContentBlockParam[] = m.bloques.map((b) =>
    b.tipo === "resultado"
      ? { type: "tool_result", tool_use_id: b.id, content: b.contenido, is_error: b.esError }
      : { type: "text", text: b.tipo === "texto" ? b.texto : "" },
  );
  return { role: "user", content: contenido };
}

const textoDe = (m: MensajeLLM) => m.bloques.map((b) => (b.tipo === "texto" ? b.texto : "")).join("\n");

function traducirError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "La clave del proveedor LLM es inválida o no está configurada.";
  if (e instanceof Anthropic.RateLimitError) return "El proveedor LLM está limitando peticiones. Intenta de nuevo en unos segundos.";
  if (e instanceof Anthropic.APIConnectionTimeoutError) return "El proveedor LLM no respondió a tiempo (timeout). Intenta de nuevo.";
  if (e instanceof Anthropic.APIError) return `Error del proveedor LLM (${e.status ?? "sin estado"}). Intenta de nuevo.`;
  return "Error inesperado al llamar al proveedor LLM.";
}
