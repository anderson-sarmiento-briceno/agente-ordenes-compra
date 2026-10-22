// Selección del proveedor LLM por variable de entorno (LLM_PROVIDER). Hoy: anthropic.
import type { ProveedorLLM } from "./adapter.js";
import { ProveedorAnthropic } from "./anthropic.js";

export function crearProveedorLLM(): ProveedorLLM {
  const proveedor = process.env.LLM_PROVIDER ?? "anthropic";
  if (proveedor === "anthropic") return new ProveedorAnthropic();
  throw new Error(`Proveedor LLM no soportado: ${proveedor}`);
}
