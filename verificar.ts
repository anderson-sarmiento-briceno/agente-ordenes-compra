// Verifica que los fixtures tengan la forma que esperan los esquemas zod de src/datos.ts.
// Muestra TODOS los problemas de una vez (no se detiene en el primero).
// Uso: npm run verificar   (útil justo después de copiar los fixtures reales)
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import {
  AprobacionSchema,
  CentroCostoSchema,
  CondicionPagoSchema,
  CorreoSchema,
  DIR_MAESTROS,
  DIR_SOLICITUDES,
  IndicadorIvaSchema,
  leerTexto,
  ProveedorSchema,
  RAIZ,
  SolicitudSchema,
} from "./src/datos.js";

let errores = 0;
let avisos = 0;
const rel = (ruta: string) => relative(RAIZ, ruta).replaceAll("\\", "/");
const ok = (msg: string) => console.log(`  ✅ ${msg}`);
const error = (msg: string) => (errores++, console.log(`  ❌ ${msg}`));
const aviso = (msg: string) => (avisos++, console.log(`  ⚠️  ${msg}`));

/** Campos que vienen en el JSON pero no están en el esquema (zod los ignora en silencio). */
function camposExtra(esquema: z.ZodType, datos: unknown, ruta: string, encontrados = new Set<string>()) {
  if (esquema instanceof z.ZodOptional) return camposExtra(esquema.unwrap() as z.ZodType, datos, ruta, encontrados);
  if (esquema instanceof z.ZodArray && Array.isArray(datos)) {
    for (const item of datos) camposExtra(esquema.element as z.ZodType, item, `${ruta}[]`, encontrados);
  } else if (esquema instanceof z.ZodObject && datos && typeof datos === "object" && !Array.isArray(datos)) {
    const shape = esquema.shape as Record<string, z.ZodType>;
    for (const [clave, valor] of Object.entries(datos)) {
      const ruta2 = ruta ? `${ruta}.${clave}` : clave;
      if (!(clave in shape)) encontrados.add(ruta2);
      else camposExtra(shape[clave], valor, ruta2, encontrados);
    }
  }
  return encontrados;
}

function revisarJson(ruta: string, esquema: z.ZodType) {
  if (!existsSync(ruta)) return error(`${rel(ruta)}: NO EXISTE`);
  let datos: unknown;
  try {
    datos = JSON.parse(leerTexto(ruta));
  } catch (e) {
    return error(`${rel(ruta)}: JSON inválido (${(e as Error).message})`);
  }
  const r = esquema.safeParse(datos);
  if (r.success) ok(rel(ruta));
  else
    for (const issue of r.error.issues)
      error(`${rel(ruta)}: campo "${issue.path.join(".") || "(raíz)"}" → ${issue.message}`);
  for (const extra of camposExtra(esquema, datos, ""))
    aviso(`${rel(ruta)}: campo "${extra}" no está en el esquema (se ignora)`);
}

console.log("\n=== Maestros ===");
revisarJson(join(DIR_MAESTROS, "proveedores.json"), z.array(ProveedorSchema));
revisarJson(join(DIR_MAESTROS, "centros-costo.json"), z.array(CentroCostoSchema));
revisarJson(join(DIR_MAESTROS, "indicadores-iva.json"), z.array(IndicadorIvaSchema));
revisarJson(join(DIR_MAESTROS, "condiciones-pago.json"), z.array(CondicionPagoSchema));

const ESPERADOS = ["correo.json", "solicitud.json", "cotizacion.txt", "aprobacion.json", "factura.txt"];
const carpetas = existsSync(DIR_SOLICITUDES)
  ? readdirSync(DIR_SOLICITUDES, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  : [];

for (const id of carpetas) {
  console.log(`\n=== ${id} ===`);
  const dir = join(DIR_SOLICITUDES, id);
  if (!/^sol-\d{3}$/.test(id)) aviso(`El nombre "${id}" no tiene la forma sol-000: las herramientas lo rechazarán (ver cargarSolicitud).`);

  revisarJson(join(dir, "correo.json"), CorreoSchema);
  revisarJson(join(dir, "solicitud.json"), SolicitudSchema);
  revisarJson(join(dir, "aprobacion.json"), AprobacionSchema);
  if (existsSync(join(dir, "cotizacion.txt"))) ok("cotizacion.txt");
  else error("cotizacion.txt: NO EXISTE");
  if (existsSync(join(dir, "factura.txt"))) ok("factura.txt (compra retroactiva)");

  for (const archivo of readdirSync(dir))
    if (!ESPERADOS.includes(archivo)) aviso(`Archivo no esperado: ${archivo}`);

  try {
    const sol = JSON.parse(leerTexto(join(dir, "solicitud.json")));
    if (sol?.id !== undefined && sol.id !== id) aviso(`solicitud.json tiene id "${sol.id}" pero la carpeta se llama "${id}"`);
  } catch {
    // ya se reportó arriba
  }
}

console.log(`\n=== Resumen: ${carpetas.length} solicitudes · ${errores} errores · ${avisos} avisos ===`);
if (errores > 0) console.log("Ajusta los esquemas en src/datos.ts (o los controles que usen esos campos) y vuelve a correr.");
process.exit(errores > 0 ? 1 : 0);
