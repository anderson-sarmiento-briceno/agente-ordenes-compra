// Demo determinista: procesa todas las solicitudes llamando las herramientas
// DIRECTAMENTE, sin LLM. Si se corre dos veces, el resultado es el mismo.
// Al final imprime la matriz casos × controles en markdown (para SOLUCION.md).
// Uso: npm run demo
import { ejecutarHerramienta } from "./src/tools/oc.js";
import type { Evaluacion } from "./src/controles.js";

const ICONO = { OK: "✅", FALLA: "❌", ALERTA: "⚠️" } as const;

function llamar(nombre: string, input: unknown = {}) {
  const r = ejecutarHerramienta(nombre, input);
  if (!r.ok) throw new Error(`${nombre} falló: ${r.error}`);
  return r.datos;
}

const pesos = (n: number) => "$" + n.toLocaleString("es-CO");
const solicitudes = llamar("listar_solicitudes") as { id: string; asunto: string }[];
const filas: { ev: Evaluacion; resultado: string; oc: string }[] = [];

for (const { id, asunto } of solicitudes) {
  console.log(`\n=== ${id}: ${asunto} ===`);
  const ev = llamar("validar_solicitud", { solicitudId: id }) as Evaluacion;
  for (const c of ev.controles) console.log(`  ${ICONO[c.estado]} ${c.codigo} ${c.control}: ${c.detalle}`);
  console.log(`  Subtotal ${pesos(ev.datosOC.subtotal)} | IVA ${pesos(ev.datosOC.iva)} | Total ${pesos(ev.datosOC.total)}`);

  if (!ev.apta) {
    filas.push({ ev, resultado: "Rechazada", oc: "-" });
    continue;
  }
  // En el chat aquí se pausaría para la confirmación humana; en la demo se asume aprobada.
  const r = llamar("crear_orden_compra", { solicitudId: id }) as { creada: boolean; oc: { numero: string } };
  console.log(`  -> OC creada en SAP: ${r.oc.numero}${ev.retroactiva ? " (marcada RETROACTIVA)" : ""}`);
  filas.push({ ev, resultado: ev.retroactiva ? "OC creada (retroactiva)" : "OC creada", oc: r.oc.numero });
}

// Prueba de idempotencia: pedir otra vez la OC de la primera solicitud no debe duplicarla.
const primera = filas.find((f) => f.oc !== "-");
if (primera) {
  const r = llamar("crear_orden_compra", { solicitudId: primera.ev.solicitudId }) as { yaExistia?: boolean; oc: { numero: string } };
  console.log(`\nIdempotencia: segunda creación de ${primera.ev.solicitudId} -> yaExistia=${r.yaExistia}, OC ${r.oc.numero}`);
}

// ---- Matriz casos × controles (markdown, lista para pegar en SOLUCION.md §3) ----
const codigos = filas[0]?.ev.controles.map((c) => c.codigo) ?? [];
const linea = (celdas: string[]) => `| ${celdas.join(" | ")} |`;
console.log("\n=== Matriz de resultados (pegar en SOLUCION.md) ===\n");
console.log(linea(["Solicitud", ...codigos, "Total", "Resultado", "OC"]));
console.log(linea(["---", ...codigos.map(() => ":-:"), "--:", "---", "---"]));
for (const { ev, resultado, oc } of filas) {
  const iconos = codigos.map((cod) => ICONO[ev.controles.find((c) => c.codigo === cod)?.estado ?? "OK"]);
  console.log(linea([ev.solicitudId, ...iconos, pesos(ev.datosOC.total), resultado, oc]));
}
console.log(`\nLeyenda: ${ICONO.OK} OK · ${ICONO.FALLA} FALLA (bloquea) · ${ICONO.ALERTA} ALERTA (no bloquea)`);
console.log(`Controles: ${filas[0]?.ev.controles.map((c) => `${c.codigo} ${c.control}`).join(" · ") ?? ""}`);
