import { Router, type Request, type Response } from "express";
import { getIcs } from "./icsStore.js";

export const icsRouter = Router();

icsRouter.get("/ics/:id", (req: Request, res: Response) => {
  const content = getIcs(req.params.id);
  if (!content) {
    res.sendStatus(404);
    return;
  }
  // WhatsApp Business API solo acepta como "documento" un puñado de MIME
  // types (PDF, Word, Excel, PowerPoint, texto plano) — text/calendar no
  // está en esa lista, así que Twilio lo descartaba y mandaba solo el
  // texto del caption. Servirlo como text/plain (permitido) con el
  // nombre de archivo en .ics alcanza: el teléfono lo abre con la app de
  // calendario igual, porque decide qué usar por la extensión del
  // archivo descargado, no por el Content-Type que viajó en el pedido.
  res.set("Content-Disposition", 'attachment; filename="visita.ics"');
  res.type("text/plain").send(content);
});
