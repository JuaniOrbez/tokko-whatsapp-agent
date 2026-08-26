import crypto from "node:crypto";

/**
 * Guarda el contenido de un .ics en memoria un rato, con un ID al azar, para
 * poder servirlo por HTTP (ver icsRouter.ts) — Twilio necesita una URL
 * pública para adjuntar un archivo a un mensaje saliente, no acepta el
 * contenido directo.
 */
interface StoredIcs {
  content: string;
  createdAt: number;
}

const TTL_MS = 60 * 60 * 1000; // 1 hora alcanza de sobra para que Twilio lo descargue
const store = new Map<string, StoredIcs>();

function cleanup(): void {
  const now = Date.now();
  for (const [id, entry] of store) {
    if (now - entry.createdAt > TTL_MS) store.delete(id);
  }
}

export function storeIcs(content: string): string {
  cleanup();
  const id = crypto.randomUUID();
  store.set(id, { content, createdAt: Date.now() });
  return id;
}

export function getIcs(id: string): string | undefined {
  cleanup();
  return store.get(id)?.content;
}
