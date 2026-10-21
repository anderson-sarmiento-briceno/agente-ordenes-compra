# Agente de Compras: órdenes de compra en SAP simulado

Agente conversacional en TypeScript que lee solicitudes de compra, valida los controles obligatorios y crea órdenes de compra (OC) en un SAP simulado, con **confirmación humana** antes de escribir en SAP.

## Arquitectura

```
public/index.html   Chat web: muestra mensajes, llamadas a herramientas y confirmaciones
src/server.ts       Servidor Express (API /api/chat y /api/confirmar)
src/agent.ts        Ciclo del agente con Claude (pausa para confirmación humana)
agent/prompt.md     System prompt
src/tools/oc.ts     Herramientas tipadas con zod
src/controles.ts    Controles de negocio (funciones puras, deterministas)
src/datos.ts        Lectura y validación de fixtures
src/sap/simulado.ts SAP simulado (idempotente por solicitud)
demo.ts             Procesa todos los casos sin LLM
```

La lógica de negocio vive en las herramientas, no en el modelo: Claude decide qué herramienta usar y conversa; las validaciones son código determinista.

## Uso

```bash
npm install
cp .env.example .env    # y poner ANTHROPIC_API_KEY
npm run demo            # casos sin LLM
npm run dev             # chat en http://localhost:3000
```

Ver `SOLUCION.md` para el detalle de la solución.
