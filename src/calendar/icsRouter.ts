import { Router, type Request, type Response } from "express";
import { getIcs } from "./icsStore.js";

export const icsRouter = Router();

icsRouter.get("/ics/:id", (req: Request, res: Response) => {
  const content = getIcs(req.params.id);
  if (!content) {
    res.sendStatus(404);
    return;
  }
  res.set("Content-Disposition", 'attachment; filename="visita.ics"');
  res.type("text/calendar").send(content);
});
