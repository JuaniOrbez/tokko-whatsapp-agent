import express from "express";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { webhookRouter } from "./whatsapp/webhook.js";
import { adminRouter } from "./admin/router.js";
import { icsRouter } from "./calendar/icsRouter.js";
import { startScheduler } from "./scheduler.js";

const app = express();

// Twilio manda los webhooks como application/x-www-form-urlencoded.
app.use(express.urlencoded({ extended: false }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use(webhookRouter);
app.use(adminRouter);
app.use(icsRouter);

app.listen(config.PORT, () => {
  logger.info("server.started", { port: config.PORT });
  startScheduler();
});
