// Servidor web: expone la API del agente y sirve el chat (carpeta public/).
import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { confirmar, enviarMensaje } from "./agent.js";
import { sap } from "./sap/simulado.js";

// Carga el .env en local (en Render las variables se configuran en el panel).
try {
  process.loadEnvFile();
} catch {
  // no hay .env: se usan las variables de entorno del sistema
}

const app = express();
app.use(express.json());
app.use(express.static(join(dirname(fileURLToPath(import.meta.url)), "..", "public")));

const SesionId = z.string().min(8).max(64);
const ChatBody = z.object({ sesionId: SesionId, mensaje: z.string().min(1).max(4000) });
const ConfirmarBody = z.object({ sesionId: SesionId, aprobado: z.boolean() });

app.post("/api/chat", async (req, res) => {
  const body = ChatBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Petición inválida" });
  try {
    res.json(await enviarMensaje(body.data.sesionId, body.data.mensaje));
  } catch (e) {
    manejarError(res, e);
  }
});

app.post("/api/confirmar", async (req, res) => {
  const body = ConfirmarBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Petición inválida" });
  try {
    res.json(await confirmar(body.data.sesionId, body.data.aprobado));
  } catch (e) {
    manejarError(res, e);
  }
});

app.get("/api/ordenes", (_req, res) => res.json(sap.listar()));
app.get("/api/salud", (_req, res) => res.json({ ok: true, apiKey: !!process.env.ANTHROPIC_API_KEY }));

function manejarError(res: express.Response, e: unknown) {
  // Nunca se devuelve la API key ni detalles internos; solo un mensaje entendible.
  if (e instanceof Anthropic.AuthenticationError) return res.status(500).json({ error: "API key de Anthropic inválida o ausente." });
  if (e instanceof Anthropic.RateLimitError) return res.status(429).json({ error: "Límite de peticiones a Claude. Intenta en unos segundos." });
  if (e instanceof Anthropic.APIError) return res.status(502).json({ error: `Error de la API de Claude (${e.status}).` });
  console.error(e);
  res.status(400).json({ error: e instanceof Error ? e.message : "Error desconocido" });
}

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => console.log(`Servidor listo en http://localhost:${PORT}`));
