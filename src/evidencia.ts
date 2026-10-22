// Evidencia de aprobación (HU-4, P0): out/<caso>/aprobacion.txt con encabezados, cuerpo y sha256.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { leerAprobacionArchivo } from "./datos.js";
import { rutaOut } from "./registro.js";

/** Contenido y hash de la evidencia. Determinista: mismo correo -> mismo sha256. */
export function calcularEvidencia(raiz: string, caso: string): { contenido: string; sha256: string } {
  const ap = leerAprobacionArchivo(raiz, caso);
  if (!ap) throw new Error(`El caso ${caso} no tiene correo de aprobación`);
  const cuerpo = [`De: ${ap.de}`, `Para: ${ap.para}`, `Fecha: ${ap.fecha}`, `Asunto: ${ap.asunto}`, "", ap.cuerpo].join("\n");
  const sha256 = createHash("sha256").update(cuerpo, "utf8").digest("hex");
  return { contenido: `${cuerpo}\n\n---\nSHA-256: ${sha256}\n`, sha256 };
}

export function generarEvidencia(raiz: string, caso: string): { ruta: string; sha256: string } {
  const { contenido, sha256 } = calcularEvidencia(raiz, caso);
  mkdirSync(rutaOut(raiz, caso), { recursive: true });
  const ruta = rutaOut(raiz, caso, "aprobacion.txt");
  writeFileSync(ruta, contenido, "utf8");
  return { ruta: `out/${caso}/aprobacion.txt`, sha256 };
}
