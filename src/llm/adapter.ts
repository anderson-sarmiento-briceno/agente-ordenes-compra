// Interfaz propia del proveedor LLM (sección 6.1 del PRD): el ciclo del agente solo conoce estos tipos.
// Cambiar de proveedor = escribir otra implementación de ProveedorLLM; el ciclo no se toca.

export type Bloque =
  | { tipo: "texto"; texto: string }
  | { tipo: "llamada"; id: string; nombre: string; args: unknown }
  | { tipo: "resultado"; id: string; contenido: string; esError: boolean };

export interface MensajeLLM {
  rol: "usuario" | "asistente";
  bloques: Bloque[];
  /** Contenido original del proveedor (p. ej. bloques de razonamiento) para reenviarlo sin cambios. */
  nativo?: unknown;
}

export interface HerramientaLLM {
  nombre: string;
  descripcion: string;
  esquema: Record<string, unknown>; // JSON Schema
}

export interface RespuestaLLM {
  mensaje: MensajeLLM;
  fin: "texto" | "herramientas" | "limite" | "rechazo";
  uso: { tokensEntrada: number; tokensSalida: number; costoUsd: number };
}

export interface ProveedorLLM {
  readonly proveedor: string;
  readonly modelo: string;
  enviar(sistema: string, mensajes: MensajeLLM[], herramientas: HerramientaLLM[]): Promise<RespuestaLLM>;
}

/** Error del proveedor ya traducido a un mensaje claro para mostrar en el chat (CA5). */
export class ErrorProveedorLLM extends Error {}
