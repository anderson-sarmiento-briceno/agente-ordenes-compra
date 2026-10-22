# Agente de órdenes de compra SAP (Reto técnico 03)

Agente conversacional que lee el paquete de una solicitud de compra, lo valida contra los maestros (reglas RC1–RC10), construye el payload de la OC, genera la evidencia de aprobación y crea la OC en un SAP simulado, pidiendo confirmación humana en las excepciones.

- **Link para probar:** https://agente-ordenes-compra-nviw.onrender.com (plan gratuito: la primera carga puede tardar ~50 s). Sin clave de acceso.
- **Documentación de la solución:** [SOLUCION.md](SOLUCION.md)

## Levantar en local (un comando)

Requiere Node.js 20+ (probado con Node 24).

```bash
npm install
cp .env.example .env      # completar ANTHROPIC_API_KEY
npm run dev               # front + backend en http://localhost:3000
```

## Verificación sin modelo (`demo.ts`)

No requiere ninguna clave:

```bash
npm install && npm run demo
```

Limpia `out/`, procesa los 6 casos llamando directamente a las herramientas, confirma explícitamente los pendientes (incluido `sol-004`), demuestra la idempotencia ejecutando `sol-001` dos veces e imprime la matriz de controles y `out/control.csv`.

Otros comandos: `npm run verificar` (valida los fixtures contra los esquemas zod) y `npm run typecheck`.

## Variables de entorno

| Variable | Obligatoria | Defecto | Uso |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Sí (chat) | — | Clave del proveedor LLM. Solo en el backend. |
| `LLM_PROVIDER` | No | `anthropic` | Implementación del adaptador LLM. |
| `ANTHROPIC_MODEL` | No | `claude-haiku-5-5` | Modelo. |
| `MAX_ITERACIONES` | No | `25` | Tope de vueltas por turno. |
| `MAX_TOKENS_SESION` | No | `300000` | Tope de tokens por sesión. |
| `LLM_TIMEOUT_MS` | No | `60000` | Timeout por llamada al modelo. |
| `PORT` | No | `3000` | Puerto HTTP. |

## API

| Método | Ruta | Cuerpo → respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation, uso }` |
| `GET` | `/api/sessions/:id` | Historial de la sesión (mensajes, llamadas a herramientas, confirmaciones) |
| `GET` | `/api/health` | `{ ok: true, provider, model }` (sin claves) |
| `GET` | `/api/ordenes` | OC creadas en el SAP simulado (`out/sap/ordenes.jsonl`) |

`toolCalls[]`: `{ herramienta, args, ok, resultado }`. Si `needsConfirmation` es `true`, el agente terminó el turno con una pregunta y solo creará la OC si el siguiente mensaje confirma ("Confirmo").

## Estructura

```
agent/prompt.md               comportamiento (system prompt)
src/knowledge/                conocimiento del proceso
src/tools/oc.ts               ejecución: herramientas zod (oc_leer_paquete, oc_validar, oc_construir_payload, oc_generar_evidencia, oc_crear)
src/tools/index.ts            registro, validación de argumentos y log de llamadas
src/agent.ts                  ciclo del agente y confirmación humana
src/llm/                      adaptador de proveedor LLM (interfaz + Anthropic)
src/sap/                      SapAdapter (interfaz) + mock sobre archivos
src/controles.ts              reglas RC1–RC10 (funciones puras)
src/datos.ts                  lectura y normalización de fixtures
src/payload.ts                esquema zod de la OC y trazabilidad
src/evidencia.ts              evidencia de aprobación con sha256
src/server.ts                 API HTTP
public/index.html             front de chat
fixtures/reto-03/             entregados por Periferia (no se modifican)
out/                          generado en ejecución (no versionado)
demo.ts                       verificación sin modelo
```
