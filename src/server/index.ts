import cors from "cors";
import dotenv from "dotenv";
import express, { type ErrorRequestHandler } from "express";
import { callsRouter } from "./routes/calls.js";
import { toolsRouter } from "./routes/tools.js";
import { vapiRouter } from "./routes/vapi.js";

dotenv.config();

const app = express();
const port = Number(process.env.PORT ?? 3001);

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "ai-sdr" });
});

app.use("/api", toolsRouter);
app.use("/api", callsRouter);
app.use("/api", vapiRouter);

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const message = error instanceof Error ? error.message : "Unexpected server error";

  res.status(400).json({ error: message });
};

app.use(errorHandler);

app.listen(port, () => {
  console.log(`AI SDR API listening on http://localhost:${port}`);
});
