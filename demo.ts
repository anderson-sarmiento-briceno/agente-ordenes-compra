// Demo determinista: procesa todas las solicitudes llamando las herramientas
// DIRECTAMENTE, sin LLM. Si se corre dos veces, el resultado es el mismo.
// Uso: npm run demo
import { ejecutarHerramienta } from "./src/tools/oc.js";
import type { Evaluacion } from "./src/controles.js";

const ICONO = { OK: "✅", FALLA: "❌", ALERTA: "⚠️ " } as const;

function llamar(nombre: string, input: unknown = {}) {
  const r = ejecutarHerramienta(nombre, input);
  if (!r.ok) throw new Error(`${nombre} falló: ${r.error}`);
  return r.datos;
}

const solicitudes = llamar("listar_solicitudes") as { id: string; asunto: string }[];
const resumen: { solicitud: string; resultado: string; oc: string }[] = [];

for (const { id, asunto } of solicitudes) {
  console.log(`\n=== ${id}: ${asunto} ===`);
  const ev = llamar("validar_solicitud", { solicitudId: id }) as Evaluacion;
  for (const c of ev.controles) console.log(`  ${ICONO[c.estado]} ${c.codigo} ${c.control}: ${c.detalle}`);
  console.log(`  Subtotal ${ev.datosOC.subtotal} | IVA ${ev.datosOC.iva} | Total ${ev.datosOC.total}`);

  if (!ev.apta) {
    resumen.push({ solicitud: id, resultado: "RECHAZADA (controles)", oc: "-" });
    continue;
  }
  // En el chat aquí se pausaría para la confirmación humana; en la demo se asume aprobada.
  const r = llamar("crear_orden_compra", { solicitudId: id }) as { creada: boolean; oc: { numero: string } };
  console.log(`  -> OC creada en SAP: ${r.oc.numero}${ev.retroactiva ? " (marcada RETROACTIVA)" : ""}`);
  resumen.push({ solicitud: id, resultado: ev.retroactiva ? "OC creada (retroactiva)" : "OC creada", oc: r.oc.numero });
}

// Prueba de idempotencia: pedir otra vez la OC de la primera solicitud no debe duplicarla.
const primera = resumen.find((r) => r.oc !== "-");
if (primera) {
  const r = llamar("crear_orden_compra", { solicitudId: primera.solicitud }) as { yaExistia?: boolean; oc: { numero: string } };
  console.log(`\nIdempotencia: segunda creación de ${primera.solicitud} -> yaExistia=${r.yaExistia}, OC ${r.oc.numero}`);
}

console.log("\n=== Resumen ===");
console.table(resumen);
