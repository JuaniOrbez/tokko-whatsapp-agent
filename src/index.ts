import express from "express";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { webhookRouter } from "./whatsapp/webhook.js";

const app = express();

// Twilio manda los webhooks como application/x-www-form-urlencoded.
app.use(express.urlencoded({ extended: false }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use(webhookRouter);

app.listen(config.PORT, () => {
  logger.info("server.started", { port: config.PORT });
});
