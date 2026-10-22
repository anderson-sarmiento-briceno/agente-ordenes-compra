// Demo determinista (sección 6.6 del PRD): procesa los 6 casos llamando DIRECTAMENTE a las
// herramientas, sin modelo de lenguaje ni API key. Mismo resultado en cada ejecución (salvo timestamps).
// Uso: npm run demo
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Validacion } from "./src/controles.js";
import { listarCasos } from "./src/datos.js";
import { ejecutarHerramienta } from "./src/tools/index.js";

const raiz = dirname(fileURLToPath(import.meta.url));
const ctx = { directory: raiz, sessionId: "demo" };
rmSync(join(raiz, "out"), { recursive: true, force: true }); // out/ se limpia al inicio

type Resultado<T> = { ok: true; data: T } | { ok: false; error: string };
async function llamar<T>(herramienta: string, args: Record<string, unknown>): Promise<Resultado<T>> {
  return JSON.parse(await ejecutarHerramienta(herramienta, args, ctx)) as Resultado<T>;
}
type OC = { numero_oc: string; idempotente: boolean; retroactiva?: boolean; evidencia?: string };

const ICONO = { ok: "✅", bloqueo: "⛔", confirmacion: "❓", derivado: "🔁" } as const;
const filas: { caso: string; v: Validacion; resultado: string }[] = [];
const pendientes: string[] = [];

console.log("=== Fase 1: procesar los 6 casos (sin confirmaciones) ===");
for (const caso of listarCasos(raiz)) {
  console.log(`\n── ${caso} ──`);
  const paquete = await llamar<{ solicitud: { solicitud_id: string; descripcion: string } }>("oc_leer_paquete", { caso });
  if (!paquete.ok) {
    console.log(`  ERROR al leer: ${paquete.error}`);
    continue;
  }
  console.log(`  ${paquete.data.solicitud.solicitud_id}: ${paquete.data.solicitud.descripcion}`);

  const val = await llamar<Validacion>("oc_validar", { caso });
  if (!val.ok) {
    console.log(`  ERROR al validar: ${val.error}`);
    continue;
  }
  const v = val.data;
  console.log(`  apta: ${v.apta} · retroactiva: ${v.retroactiva}`);
  for (const b of v.bloqueos) console.log(`  ⛔ ${b.regla} ${b.detalle}\n     → Acción: ${b.accion}`);
  for (const c of v.confirmaciones) console.log(`  ❓ ${c.regla} ${c.detalle}`);
  for (const [campo, d] of Object.entries(v.derivados)) console.log(`  🔁 ${campo} = ${d.valor} (${d.fuente})`);

  const oc = await llamar<OC>("oc_crear", { caso });
  if (oc.ok) {
    console.log(`  ✔ OC ${oc.data.numero_oc} creada sin intervención humana`);
    filas.push({ caso, v, resultado: `OC ${oc.data.numero_oc}` });
  } else if (v.apta) {
    console.log(`  ⏸ Pendiente de confirmación humana`);
    pendientes.push(caso);
    filas.push({ caso, v, resultado: "pendiente" });
  } else {
    console.log(`  ✖ No se crea: ${v.bloqueos.map((b) => b.regla).join(", ")}`);
    filas.push({ caso, v, resultado: `bloqueada (${v.bloqueos.map((b) => b.regla).join(", ")})` });
  }
}

console.log("\n=== Fase 2: el usuario confirma explícitamente los casos pendientes ===");
for (const caso of pendientes) {
  console.log(`\n  Usuario: "Confirmo la creación de ${caso}"`);
  const oc = await llamar<OC>("oc_crear", { caso, confirmado: true });
  const fila = filas.find((f) => f.caso === caso);
  if (oc.ok && fila) {
    console.log(`  ✔ OC ${oc.data.numero_oc} creada con confirmación${oc.data.retroactiva ? " · marcada RETROACTIVA" : ""}`);
    fila.resultado = `OC ${oc.data.numero_oc} (confirmada${oc.data.retroactiva ? ", retroactiva" : ""})`;
  } else if (!oc.ok) console.log(`  ✖ ${oc.error}`);
}

console.log("\n=== Fase 3: idempotencia (sol-001 otra vez) ===");
const repetida = await llamar<OC>("oc_crear", { caso: "sol-001" });
console.log(repetida.ok ? `  sol-001 → OC ${repetida.data.numero_oc}, idempotente = ${repetida.data.idempotente}` : `  ✖ ${repetida.error}`);

console.log("\n=== Matriz de controles (pegar en SOLUCION.md) ===\n");
const reglas = ["RC1", "RC2", "RC3", "RC4", "RC5", "RC6", "RC7", "RC8", "RC9", "RC10"];
console.log(`| Caso | ${reglas.join(" | ")} | Retroactiva | Resultado |`);
console.log(`| --- | ${reglas.map(() => ":-:").join(" | ")} | :-: | --- |`);
for (const { caso, v, resultado } of filas) {
  const celdas = reglas.map((r) => ICONO[v.controles.find((c) => c.regla === r)?.estado ?? "ok"]);
  console.log(`| ${caso} | ${celdas.join(" | ")} | ${v.retroactiva ? "sí" : "no"} | ${resultado} |`);
}
console.log("\nLeyenda: ✅ ok · ⛔ bloqueo · ❓ confirmación · 🔁 derivado");

const control = join(raiz, "out", "control.csv");
if (existsSync(control)) console.log(`\n=== out/control.csv ===\n${readFileSync(control, "utf8")}`);
