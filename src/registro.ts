// Registros en out/: log de llamadas a herramientas (CA4) y log de control para auditoría (HU-5).
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const rutaOut = (raiz: string, ...partes: string[]) => join(raiz, "out", ...partes);

function asegurarOut(raiz: string) {
  mkdirSync(rutaOut(raiz), { recursive: true });
}

/** Una línea JSON por llamada a herramienta: out/log.jsonl */
export function registrarLlamada(raiz: string, entrada: { sessionId: string; herramienta: string; args: unknown; ok: boolean; error?: string }) {
  asegurarOut(raiz);
  appendFileSync(rutaOut(raiz, "log.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...entrada }) + "\n");
}

export interface FilaControl {
  solicitud_id: string;
  resultado: "creada" | "idempotente" | "bloqueada" | "pendiente" | "rechazada";
  numero_oc: string;
  retroactiva: boolean;
  bloqueos: string[];
  confirmaciones: string[];
}

const COLUMNAS = "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts";
const celda = (v: string) => `"${v.replaceAll('"', '""')}"`;

/** Una fila por intento de crear OC: out/control.csv */
export function registrarControl(raiz: string, f: FilaControl) {
  asegurarOut(raiz);
  const ruta = rutaOut(raiz, "control.csv");
  if (!existsSync(ruta)) appendFileSync(ruta, COLUMNAS + "\n");
  const valores = [f.solicitud_id, f.resultado, f.numero_oc, String(f.retroactiva), f.bloqueos.join(";"), f.confirmaciones.join(";"), new Date().toISOString()];
  appendFileSync(ruta, valores.map(celda).join(",") + "\n");
}
