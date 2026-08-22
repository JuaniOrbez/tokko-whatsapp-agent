import express, { type Request } from "express";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { webhookRouter } from "./whatsapp/webhook.js";

const app = express();

app.use(
  express.json({
    verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use(webhookRouter);

app.listen(config.PORT, () => {
  logger.info("server.started", { port: config.PORT });
});
