// Genera modulo/ (bonus 9.4) a partir de las MISMAS fuentes que usa la aplicación:
//   agent/prompt.md              -> modulo/agent.md (frontmatter + system prompt)
//   src/knowledge/*.md           -> modulo/skill/ordenes-compra/SKILL.md
//   src/tools/oc.ts (reexportado) -> modulo/tools/oc.ts
// Uso: npm run modulo   (volver a correrlo si cambia el prompt o el conocimiento)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const leer = (ruta: string) => readFileSync(join(raiz, ruta), "utf8").replace(/^﻿/, "");
const escribir = (ruta: string, contenido: string) => {
  mkdirSync(dirname(join(raiz, ruta)), { recursive: true });
  writeFileSync(join(raiz, ruta), contenido);
  console.log(`✔ ${ruta}`);
};
const AVISO = "<!-- Generado por scripts/generar-modulo.ts. No editar a mano: editar la fuente y volver a generar. -->";

escribir(
  "modulo/agent.md",
  `---
description: Agente que lee solicitudes de compra, las valida (RC1–RC10) y crea la orden de compra en SAP con confirmación humana en las excepciones.
mode: primary
permission:
  edit: deny
  bash: deny
---
${AVISO}

${leer("agent/prompt.md")}`,
);

escribir(
  "modulo/skill/ordenes-compra/SKILL.md",
  `---
name: ordenes-compra
description: Conocimiento del proceso de órdenes de compra de Periferia (paquete de la solicitud, reglas de control RC1–RC10, glosario SAP). Úsalo al procesar solicitudes de compra.
---
${AVISO}

${leer("src/knowledge/ordenes-compra.md")}`,
);

escribir(
  "modulo/tools/oc.ts",
  `// Generado por scripts/generar-modulo.ts. Reexporta las MISMAS herramientas de la aplicación
// (no es una copia): importables sin el servidor HTTP. Cada export -> herramienta oc_<export>.
export * from "../../src/tools/oc.js";
`,
);
