// Servidor HTTP: API del chat (sección 6.4 del PRD) y front estático (public/).
import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Carga .env en local antes de crear el proveedor LLM (en Render las variables vienen del panel).
try {
  process.loadEnvFile();
} catch {
  // sin .env: se usan las variables del sistema
}

const { historialSesion, obtenerLLM, procesarMensaje } = await import("./agent.js");
const { SapMock } = await import("./sap/mock.js");

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = express();
app.use(express.json());
app.use(express.static(join(RAIZ, "public")));

const ChatBody = z.object({ sessionId: z.string().min(8).max(64), message: z.string().min(1).max(4000) });

app.post("/api/chat", async (req, res) => {
  const body = ChatBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Petición inválida: se espera { sessionId, message }" });
  try {
    res.json(await procesarMensaje(body.data.sessionId, body.data.message));
  } catch (e) {
    // Nunca se exponen claves ni trazas internas.
    res.status(409).json({ error: e instanceof Error ? e.message : "Error inesperado" });
  }
});

app.get("/api/sessions/:id", (req, res) => {
  const historial = historialSesion(req.params.id);
  if (!historial) return res.status(404).json({ error: "Sesión no encontrada" });
  res.json({ sessionId: req.params.id, historial });
});

app.get("/api/health", (_req, res) => {
  const llm = obtenerLLM();
  res.json({ ok: true, provider: llm.proveedor, model: llm.modelo });
});

app.get("/api/ordenes", (_req, res) => res.json(new SapMock(RAIZ).listar()));

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => console.log(`Servidor listo en http://localhost:${PORT}`));
