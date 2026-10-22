# SOLUCIÓN — Agente conversacional "Órdenes de Compra SAP"

**Candidato:** Anderson Sarmiento Briceño · **Reto:** 03 · **Fecha:** 2026-10-22

- **Link para probar:** https://agente-ordenes-compra-nviw.onrender.com
- **Repositorio:** https://github.com/anderson-sarmiento-briceno/agente-ordenes-compra
- **Verificación sin modelo:** `npm install && npm run demo`

---

## 1. Problema en una frase

La analista administrativa digita a mano en SAP cada orden de compra y valida de memoria proveedor, aprobador, topes e impuestos. Esto le cuesta tiempo a ella, errores a contabilidad (que los corrige en el cierre) y visibilidad a la dirección, que no sabe cuántas OC se crean después de la factura.

---

## 2. Arquitectura

```
┌───────────────────────┐  HTTP   ┌───────────────────────────────────────────────┐
│ Front (public/)       │ ──────▶ │ Backend Express (src/server.ts)               │
│ · historial           │ ◀────── │  POST /api/chat · GET /api/sessions/:id        │
│ · llamadas a tools    │         │  GET /api/health · GET /api/ordenes            │
│ · resalta confirmación│         │                                               │
└───────────────────────┘         │  Ciclo del agente (src/agent.ts)               │
                                  │    system = agent/prompt.md                    │
                                  │           + src/knowledge/ordenes-compra.md    │
                                  │    ProveedorLLM (src/llm/adapter.ts)  ───────────▶  Claude Haiku 5.5
                                  │    Herramientas (src/tools/oc.ts, zod)         │
                                  └───────────┬─────────────────────┬─────────────┘
                                              │ lectura             │ escritura
                                   fixtures/reto-03/        out/ (sap/ordenes.jsonl, control.csv,
                                   (maestros + paquetes)         log.jsonl, <caso>/trazabilidad.json,
                                                                 <caso>/aprobacion.txt)
                 demo.ts ──(sin modelo)──▶ las mismas herramientas
```

| Capa | Dónde vive | Responsabilidad |
|---|---|---|
| **Comportamiento** | `agent/prompt.md` | Reglas de conversación: no afirmar valores sin herramienta, cuándo preguntar, formato. |
| **Conocimiento** | `src/knowledge/ordenes-compra.md` | Flujo del proceso, reglas RC1–RC10 explicadas, glosario. Se concatena al system prompt. |
| **Ejecución** | `src/tools/oc.ts` | Las 5 herramientas con el contrato `{ description, args, execute }`. |
| Reglas de negocio | `src/controles.ts` | RC1–RC10 como funciones puras. Un cambio de reglas no toca el servidor. |
| Datos | `src/datos.ts` | Lectura con zod y normalización del paquete (§7.2): extrae NIT, total, validez y fechas de los textos. |
| Payload | `src/payload.ts` | Esquema zod de la OC (§7.4) y trazabilidad campo → fuente. |
| SAP | `src/sap/adapter.ts`, `mock.ts` | Interfaz `SapAdapter` + simulador sobre archivos, idempotente. |
| LLM | `src/llm/adapter.ts`, `anthropic.ts` | Interfaz propia `enviar(sistema, mensajes, herramientas)`; cambiar de proveedor no toca el ciclo. |
| Registro | `src/registro.ts`, `src/tools/index.ts` | `out/log.jsonl` (cada llamada a herramienta) y `out/control.csv` (cada intento de crear OC). |

---

## 3. Ciclo del agente

```
mensaje del usuario
  │  ¿hay un caso pendiente de confirmación y el mensaje es "confirmo/sí/…"? → se marca confirmado (código, no el modelo)
  ▼
for i in 1..MAX_ITERACIONES (25):                                   ← CA1
   respuesta = ProveedorLLM.enviar(system, historial, herramientas)
   si responde solo texto → fin del turno
   por cada llamada a herramienta:
      guarda: oc_crear con confirmado=true solo si el usuario confirmó en ESTE mensaje   ← CA3
      ejecutarHerramienta(): valida args con zod → execute → { ok, data | error }
      registra en out/log.jsonl y en el historial visible                               ← CA4
   resultados → historial (todos en un solo mensaje) → siguiente vuelta
si se alcanza el tope → responde con lo hecho y lo que falta
```

- **Confirmación humana (CA3).** Si `oc_validar` devuelve confirmaciones u `oc_crear` responde "Requiere confirmación", el caso queda **pendiente**. La respuesta lleva `needsConfirmation: true` y el front la resalta con los botones "Confirmo" / "No confirmo", que **envían un mensaje** (también se puede escribir). En el siguiente mensaje, una expresión regular determinista decide si es una confirmación. Si el modelo intenta `oc_crear` con `confirmado: true` sin esa confirmación, el backend lo rechaza y le indica que pregunte.
- **El modelo no puede alterar valores (CA2 y riesgo del §10).** Las herramientas releen el paquete desde `fixtures/` en cada llamada. Los argumentos `paquete`, `derivados` y `payload` del contrato se aceptan, pero no se usan como fuente de verdad; si `oc_crear` recibe un `payload` distinto al reconstruido desde las fuentes, se rechaza.
- **Errores (CA5).** Las herramientas nunca lanzan: devuelven `{ ok: false, error }`. Los errores del proveedor (clave inválida, rate limit, timeout de `LLM_TIMEOUT_MS`) se traducen a un mensaje claro y la sesión sigue viva.
- **Costo.** Tope de iteraciones por turno (`MAX_ITERACIONES`) y de tokens por sesión (`MAX_TOKENS_SESION`), ambos configurables.
- **Sesiones** en memoria (`GET /api/sessions/:id` devuelve el historial visible).

---

## 4. Elección del modelo

- **Proveedor y modelo:** Anthropic, `claude-haiku-5-5`, con `effort: "low"` y caché de prompt automática.
- **Por qué:** el modelo solo interpreta la petición, decide qué herramienta llamar y redacta. Toda la lógica es determinista en las herramientas, así que un modelo mayor no mejora la corrección y sí el costo y la latencia. Haiku 5.5 cuesta USD 0,10 por millón de tokens de entrada y USD 0,50 por millón de salida.
- **Costo medido** (pruebas reales en el chat):

| Caso | Turnos | Tokens | Costo |
|---|---|---|---|
| sol-001 (flujo completo, OC creada) | 1 | ~18.100 | ~USD 0,0012 |
| sol-004 (validar + "Confirmo") | 2 | ~32.400 | ~USD 0,0019 |
| sol-003 (bloqueada) | 1 | ~13.000 | ~USD 0,0011 |

**Costo estimado por caso procesado: USD 0,001 – 0,002** (≈ USD 1 – 2 por cada 1.000 OC). `demo.ts` cuesta USD 0.

---

## 5. Matriz de controles

| Regla | Implementación (`src/controles.ts`) | Tipo |
|---|---|---|
| RC1 | Busca por NIT normalizado (sin puntos ni dígito de verificación); si no hay NIT, por nombre normalizado (sin tildes, puntuación ni mayúsculas). Verifica `activo`. Si se encontró por nombre, el NIT se informa como derivado. | Bloqueo |
| RC2 | La aprobación existe, el cuerpo contiene "Aprobado" (y no "no aprobado") y el remitente está en `aprobadores[]` del centro. | Bloqueo |
| RC3 | `valor_total` ≤ tope del aprobador. Si el aprobador no es válido, compara contra el tope máximo del centro para orientar la acción sugerida. | Bloqueo |
| RC4 | El centro existe y la subárea está en `subareas[]`. | Bloqueo |
| RC5 | `abs(cotización.total − valor_total) / valor_total` ≤ 2 %. Sin cotización legible → confirmación. Muestra ambos valores. | Confirmación |
| RC6 | Sin `indicador_iva` → se deriva `indicador_iva_default` del proveedor y se pide confirmación. Un código inexistente → bloqueo. | Derivado + confirmación |
| RC7 | Sin `condiciones_pago` → se deriva del proveedor y se informa. Un código inexistente → bloqueo. | Derivado |
| RC8 | Hay factura con fecha < `fecha_solicitud` → `retroactiva = true` + confirmación; queda en `control.csv`. | Confirmación |
| RC9 | Fecha de aprobación (día) < `fecha_solicitud` → confirmación. | Confirmación |
| RC10 | `abs(cantidad × valor_unitario − valor_total)` > 1 → bloqueo. | Bloqueo |

Cada bloqueo incluye una **acción sugerida** para el solicitante (objetivo O2).

### Resultados de `npm run demo`

| Caso | RC1 | RC2 | RC3 | RC4 | RC5 | RC6 | RC7 | RC8 | RC9 | RC10 | Retroactiva | Resultado |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | --- |
| sol-001 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | no | OC 4500000001 sin intervención humana |
| sol-002 | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | no | Bloqueada: proveedor NIT 901999000 no existe |
| sol-003 | ✅ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | no | Bloqueada: aprobador de otro centro; $74M supera todos los topes de CC-2020 |
| sol-004 | ✅ | ✅ | ✅ | ✅ | ❓ | ✅ | ✅ | ✅ | ✅ | ✅ | no | OC 4500000002 tras confirmar (cotización 6 % mayor) |
| sol-005 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❓ | ✅ | ✅ | **sí** | OC 4500000003 tras confirmar, marcada retroactiva |
| sol-006 | ✅ | ✅ | ✅ | ✅ | ✅ | 🔁❓ | 🔁 | ✅ | ✅ | ✅ | no | OC 4500000004 tras confirmar el IVA derivado (C1); proveedor hallado por nombre |

Leyenda: ✅ ok · ⛔ bloqueo · ❓ confirmación · 🔁 derivado. Una segunda ejecución de `sol-001` devuelve la misma OC (`idempotente: true`).

### La más difícil: RC5 (cotización vs. solicitud)

Es la única regla que depende de **texto libre**. Hay que extraer el total de `cotizacion.txt`, que tiene varias líneas con montos (subtotal por ítem, base gravable, IVA, total) en formato colombiano (`COP 26.500.000`). La extracción busca la línea que **empieza** por `TOTAL` y convierte el formato de miles. Además hubo que decidir qué comparar: la cotización expresa precios con IVA incluido, y el `valor_total` de la solicitud coincide con ese total en todos los casos, así que se compara total contra total (supuesto en §9). En sol-004 la diferencia está en el precio por hora ($265.000 vs $250.000), y además el líder aprobó "por 25 millones", lo que hace aún más importante pedir confirmación en lugar de crear.

---

## 6. Diseño del adaptador SAP real

### 6.1 Opción de integración, dado que la viabilidad no está confirmada

| Opción | Cuándo | Cómo se implementaría | Decisión |
|---|---|---|---|
| **OData `API_PURCHASEORDER_PROCESS_SRV`** (S/4HANA) | Si la empresa tiene S/4HANA con APIs publicadas | Como cualquier **API REST con JSON**: el adaptador hace peticiones HTTP autenticadas con OAuth 2.0. Antes de escribir pide un token CSRF (`x-csrf-token: fetch`), que SAP exige como protección. | **Primera opción.** Es el estándar de SAP, usa tecnologías web comunes (HTTP, JSON, OAuth) y es fácil de probar, monitorear y gobernar. |
| **RFC/BAPI `BAPI_PO_CREATE1`** | ECC o S/4 sin OData expuesto | Se llama una función interna de SAP mediante un conector RFC propio de SAP (Cloud Connector o middleware). Después se confirma con `BAPI_TRANSACTION_COMMIT`; los errores llegan en la tabla `RETURN`. | Alternativa. Requiere tecnología específica de SAP y más dependencia de TI. |
| **SAP Integration Suite** | Si TI centraliza integraciones | Funciona como un **orquestador de flujos**: el agente llama a un endpoint propio y un flujo (iFlow) traduce y envía a OData o BAPI, con reintentos y monitoreo centralizados. | Buena opción si la empresa ya la usa. Da más gobierno, a cambio de una pieza más. |
| **Carga por archivo** | Si no hay conexión viable | **Pipeline ETL en Python**: genera el archivo de carga con las OC ya validadas (§6.5). | Plan B. Funciona desde el día uno, sin depender de TI. |

Como la viabilidad no está confirmada, **el agente no cambia**: solo se implementa otra clase que cumpla `SapAdapter` (`consultarProveedor`, `crearOrden`, `buscarOrdenPorReferencia`). Se puede empezar con el Plan B e ir a OData cuando exista conexión.

### 6.2 Mapeo del payload (§7.4) a SAP

| Payload | OData (`A_PurchaseOrder` / `A_PurchaseOrderItem`) | BAPI `BAPI_PO_CREATE1` |
|---|---|---|
| `sociedad` | `CompanyCode` | `POHEADER-COMP_CODE` |
| `organizacion_compras` | `PurchasingOrganization` (+ `PurchasingGroup` por configuración) | `POHEADER-PURCH_ORG` / `PUR_GROUP` |
| (clase de documento) | `PurchaseOrderType` = `NB` (o una clase propia para retroactivas) | `POHEADER-DOC_TYPE` |
| `proveedor.codigo_sap` | `Supplier` | `POHEADER-VENDOR` |
| `moneda` | `DocumentCurrency` | `POHEADER-CURRENCY` |
| `condiciones_pago` | `PaymentTerms` | `POHEADER-PMNTTRMS` |
| `referencia.solicitud_id` | Campo de referencia de cabecera (p. ej. "su referencia") → **clave de idempotencia** | Campo de referencia de cabecera |
| `posiciones[].numero` | `PurchaseOrderItem` (10, 20…) | `POITEM-PO_ITEM` |
| `descripcion` (≤ 40) | `PurchaseOrderItemText` | `POITEM-SHORT_TEXT` |
| `cantidad` / `unidad` | `OrderQuantity` / `PurchaseOrderQuantityUnit` | `POITEM-QUANTITY` / `PO_UNIT` |
| `precio_unitario` | `NetPriceAmount` | `POITEM-NET_PRICE` |
| `indicador_iva` | `TaxCode` | `POITEM-TAX_CODE` |
| `centro_costo` | Imputación `K` + `CostCenter` | `POITEM-ACCTASSCAT = K` + `POACCOUNT-COSTCENTER` |
| `subarea` | Sin campo estándar: campo Z, orden interna o texto de posición (según definición de finanzas) | Igual |
| `aprobador` + evidencia | Adjunto (servicio de adjuntos / GOS) con el PDF y el sha256 en el texto de cabecera | Igual |
| `excepciones` | Texto de cabecera + log de control propio | Igual |

### 6.3 Autenticación y credenciales

- **Usuario técnico** con mínimo privilegio: crear y consultar OC en la sociedad 1000.
- OData: **OAuth 2.0 client credentials** o certificado X.509, vía un *Destination* de BTP o un gestor de secretos (Azure Key Vault / AWS Secrets Manager).
- Las credenciales viven **solo en el adaptador del backend**. Nunca en el agente, el prompt, el front ni los logs: el modelo jamás ve ni maneja credenciales, solo llama `oc_crear`.
- **API intermedia entre el agente y SAP.** El agente nunca habla con SAP directamente: el adaptador es una API propia con permisos mínimos y auditoría de cada llamada (quién confirmó, qué payload se envió, qué respondió SAP).
- **Conexión solo saliente por HTTPS** hacia la red de SAP (p. ej. SAP Cloud Connector), sin abrir puertos entrantes.

### 6.4 Idempotencia y errores parciales

1. **Antes de crear:** `buscarOrdenPorReferencia(solicitud_id)`. Si existe, se devuelve esa OC.
2. **Patrón outbox:** antes de llamar a SAP, se registra la intención (`PENDIENTE`) en una tabla de PostgreSQL con restricción `UNIQUE` sobre `solicitud_id`. La base de datos impide dos intenciones para la misma solicitud aunque lleguen en paralelo.
3. **Timeout o respuesta ambigua:** no se reintenta a ciegas. Primero se consulta por referencia y solo se crea si no existe.
4. **Reintentos** con backoff exponencial solo para errores transitorios (5xx, 429, red). Los errores de negocio (mensajes `E`/`A` en `RETURN`, 400 de OData) no se reintentan: se devuelven al agente como `{ ok: false, error }` con el texto de SAP.
5. **Error parcial** (la OC se creó pero falló el adjunto de la evidencia): se registra `creada_sin_evidencia` y **solo se reintenta el adjunto**, nunca la OC. Si en BAPI la creación devuelve advertencias `W`, se hace commit y se informan.

### 6.5 Plan B si no hay conexión

El agente igual elimina la digitación y la validación manual:
- Genera la **OC lista para pegar**: el payload validado más una vista por campo en el orden de la transacción ME21N.
- Genera un **archivo de carga masiva** (CSV o plantilla para la herramienta de migración o carga que defina TI) con todas las OC aprobadas del día.
- La analista carga el archivo y registra el número de OC devuelto; el log de control y la trazabilidad no cambian.
- **Automatización con un pipeline ETL diario en Python** hacia PostgreSQL:
  1. Extraer las OC aprobadas.
  2. Validar la calidad: llaves, montos y códigos contra los maestros.
  3. Generar el archivo de carga.
  4. Leer los números de OC que devuelve SAP y cerrar cada registro.

---

## 7. Lectura del proceso: OC retroactivas

**Lo que le diría a la dirección:** una OC creada después de la factura no controla nada: solo documenta un gasto que ya ocurrió. En el caso sol-005, la cotización es del 5 de agosto, la factura del 10 de agosto, la solicitud del 27 y la aprobación del 28. Se compró **diecisiete días antes de pedir permiso**, y la aprobación del líder ("Ya llegó la factura, por favor crear la OC para poder radicarla") fue un trámite para poder pagar. En ese escenario:

- El **control de topes y aprobadores** (RC2, RC3) pierde su función: el líder ya no puede decir que no.
- No hay **compromiso presupuestal previo** y se rompe el *three-way match* (OC – recepción – factura).
- Es la vía natural para **fraccionar compras** o usar proveedores no homologados.

**Qué ya hace el agente:** detecta el caso (RC8), lo crea solo con confirmación explícita y lo marca `retroactiva = true` en `out/control.csv`. Así, por primera vez, **la dirección puede medir el porcentaje de OC retroactivas** por área, proveedor y aprobador.

**Cambio de proceso propuesto:**
1. **Línea base y meta.** Medir 4 semanas para fijar la línea base del porcentaje de OC retroactivas, decidir la política con datos (tolerar con marca o rechazar es una pregunta abierta del PRD) y luego fijar una meta de reducción con seguimiento periódico.
2. **Flujo diferenciado:** una retroactiva exige justificación y la aprobación de un nivel superior (o de control interno) por encima de un monto.
3. **Atacar la causa:** si el motivo es la urgencia, habilitar canales rápidos legítimos (contratos marco, catálogos, OC abiertas por proveedor recurrente), para que saltarse el proceso deje de ser la vía más cómoda.
4. **Tablero en Power BI** alimentado por `out/control.csv` (en producción, por la tabla de control en PostgreSQL). Mostraría:
   - el porcentaje de retroactivas por área, proveedor y aprobador;
   - los días entre factura y OC;
   - la tendencia mensual frente a la meta.

   Se revisa en el comité.

---

## 8. Decisiones y trade-offs

| # | Decisión | Alternativa descartada | Por qué |
|---|---|---|---|
| 1 | Ciclo del agente propio sobre una interfaz `ProveedorLLM` | *Tool runner* del SDK de Anthropic | El PRD exige que cambiar de proveedor no toque el ciclo, y la confirmación CA3 necesita una guarda propia entre turnos. Con el runner, el ciclo quedaría atado al SDK. |
| 2 | Las herramientas releen las fuentes; `paquete`/`payload` del modelo no se usan como verdad | Confiar en lo que el modelo pasa entre herramientas | Evita que el modelo "arregle" montos (riesgo del §10) y ahorra tokens. Costo: se relee el disco en cada llamada (archivos pequeños: despreciable). |
| 3 | Confirmación por mensaje del usuario + guarda determinista en el backend | Botones que ejecutan la herramienta directamente (la primera versión de esta solución) | El PRD pide que el turno termine con una pregunta y que se proceda solo si el siguiente mensaje confirma. Los botones se conservan como atajo que envía "Confirmo". |
| 4 | Extracción de la cotización y la factura con expresiones regulares | Extracción con el LLM (salida estructurada) | Determinismo y costo cero en `demo.ts`. Contra: es frágil ante formatos nuevos. En producción se usaría el LLM solo para extraer (validado con zod) y la comparación seguiría en código. |
| 5 | SAP simulado y logs en archivos `out/` | Base de datos | El PRD lo pide y no requiere infraestructura. Contra: en Render el disco es efímero y no hay bloqueo entre escrituras concurrentes. |
| 6 | Claude Haiku 5.5 con `effort: low` | Un modelo mayor | La lógica está en código. Medido: ~USD 0,0015 por caso con respuestas correctas. |

---

## 9. Supuestos

1. `valor_total` de la solicitud incluye IVA, porque coincide con el "TOTAL (IVA incluido)" de las cotizaciones. RC3 y RC5 comparan totales con IVA.
2. `precio_unitario` del payload es el `valor_unitario` de la solicitud (IVA incluido). En SAP real se enviaría el neto según el indicador de IVA.
3. La unidad se infiere de la descripción: "hora(s)" → `H`; "mensualidad" o "por mes" → `MES`; en otro caso `UN`. Por eso sol-001 ("vigencia 12 meses") es `UN` (120 licencias).
4. NIT comparado sin puntos ni dígito de verificación (`900.555.111-2` ≡ `900555111`).
5. Aprobación válida si el cuerpo contiene la palabra "Aprobado" y no "no aprobado". RC9 compara solo la fecha (día).
6. Si el aprobador no pertenece al centro (RC2), RC3 se evalúa contra el tope máximo del centro, para dar una acción sugerida útil.
7. Un código de IVA o de condición de pago **informado pero inexistente** en el maestro se trata como bloqueo (el PRD solo define el caso ausente).
8. `sociedad` y `organizacion_compras` son constantes `"1000"`, según el esquema del PRD.
9. La idempotencia se basa en `solicitud_id` (`SOL-2026-00X`), no en el nombre de la carpeta.
10. Una OC sin confirmaciones se crea sin preguntar (objetivo O1), salvo que la usuaria pida revisarla antes.

---

## 10. Cobertura

| Historia | Estado | Notas / qué falta para producción |
|---|---|---|
| HU-1 Leer el paquete | ✅ Hecho | Adjuntos ausentes → `null` + `faltantes[]`. Falta leer `.xlsx`/PDF reales (P1). |
| HU-2 Validar | ✅ Hecho | RC1–RC10 con `apta`, `bloqueos`, `confirmaciones`, `derivados`, `retroactiva`. |
| HU-3 Payload | ✅ Hecho | Validado con zod; `out/<caso>/trazabilidad.json`. |
| HU-4 Evidencia | 🟡 Parcial | P0 hecho (`aprobacion.txt` + sha256). P1 PDF no hecho. |
| HU-5 Crear OC | ✅ Hecho | Número desde 4500000001, `out/sap/ordenes.jsonl`, idempotencia, `out/control.csv`. |
| HU-6 Errores | ✅ Hecho | `{ ok: false, error }` legible; JSON malformado, archivo faltante y montos no numéricos validados con zod. |
| `oc_leer_excel` (P1) | ❌ No hecho | Opcional. |
| Bonus `modulo/` | ✅ Hecho | `agent.md` y `skill/ordenes-compra/SKILL.md` se **generan** desde `agent/prompt.md` y `src/knowledge/` (`npm run modulo`); `tools/oc.ts` **reexporta** `src/tools/oc.ts`. Son las mismas piezas que usa la app, no copias. |

**Para producción falta:** adaptador SAP real, persistencia transaccional (outbox y auditoría en PostgreSQL), autenticación SSO, pruebas unitarias por regla, observabilidad y límites de uso por usuario.

---

## 11. Uso de IA

- **Asistente:** Claude Code (modelo Claude Opus 5.5), dentro de VS Code.
- **Para qué lo usé:**
  - Montar la base genérica el día anterior (Express, ciclo del agente, chat, demo) con datos inventados.
  - Adaptarla al PRD: esquemas, reglas RC1–RC10, contrato de herramientas, adaptadores SAP y LLM, front, README y este documento.
  - Revisar conceptos para la defensa: ciclo del agente, zod, idempotencia y costos.
- **Mi rol:** definí el stack y las decisiones (Haiku por costo, Render, sin frameworks en el front), revisé el código y probé cada flujo en el chat y con `demo.ts`.
- **Qué descarté de lo propuesto:**
  - **Botones que ejecutaban `oc_crear` directamente:** se cambió a confirmación por mensaje con guarda determinista, para cumplir CA3.
  - **SAP en memoria:** se pasó a archivos, como pide el PRD.
  - **Un conjunto de 9 controles genéricos** que se hipotetizó antes de conocer el PRD: se reemplazó por RC1–RC10 exactos.
  - **El *tool runner* del SDK:** se descartó por la independencia del proveedor (trade-off 1).
- **Ayuda adicional:** el asistente detectó un problema real al preparar los datos (archivos con BOM que rompían `JSON.parse`) y se corrigió en `leerTexto`.

---

## 12. Riesgos de llevar esto a producción

| Riesgo | Mitigación |
|---|---|
| **Inyección de instrucciones** en cotizaciones o correos (texto no confiable que lee el modelo) | Las decisiones están en código, las herramientas releen las fuentes, `oc_crear` revalida y la confirmación la decide el backend, no el modelo. |
| El modelo afirma un valor que no salió de una herramienta | Regla CA2 en el prompt; los payloads mostrados vienen de `oc_construir_payload`; se puede auditar en `out/log.jsonl`. |
| Formatos nuevos de cotización o factura rompen la extracción por regex | Extracción con LLM y salida validada con zod, con la comparación en código; alertar cuando no se encuentra el total (ya se reporta como faltante); diagnósticos de calidad de datos por lote (campos faltantes, montos atípicos). |
| Conexión a SAP no viable | Plan B (§6.5): OC lista para pegar o carga masiva. |
| Duplicados por reintentos o concurrencia | Clave de idempotencia en SAP + outbox + bloqueo transaccional (hoy el mock sobre archivos no tiene bloqueo). |
| Abuso del link público y de la clave | Topes de iteraciones y tokens por sesión; en producción, SSO y cuota por usuario. |
| Disco efímero en el hosting | En producción, base de datos y almacenamiento de objetos para evidencias y logs. |
| Evidencia insuficiente para auditoría | sha256 de la evidencia en el payload; evolucionar a PDF firmado si auditoría lo exige. |
