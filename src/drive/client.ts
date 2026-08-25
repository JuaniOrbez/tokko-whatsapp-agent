import { google } from "googleapis";
import { config } from "../config.js";
import { logger } from "../logger.js";

export interface DriveFileResult {
  id: string;
  name: string;
  mimeType?: string;
  downloadUrl: string;
}

const auth = new google.auth.GoogleAuth({
  keyFile: config.GOOGLE_SERVICE_ACCOUNT_FILE,
  scopes: ["https://www.googleapis.com/auth/drive"],
});

const drive = google.drive({ version: "v3", auth });

function escapeForDriveQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Busca archivos por nombre (contiene) entre todo lo que la cuenta de
 * servicio puede ver. No restringe por `GOOGLE_DRIVE_FOLDER_ID`: el permiso
 * que le diste a esa carpeta ya se hereda a todas sus subcarpetas y
 * archivos, así que alcanza con dejarla organizada como quieras (con
 * subcarpetas incluso) — no hace falta que los archivos estén sueltos.
 */
export async function findFilesByName(query: string, limit = 5): Promise<DriveFileResult[]> {
  const res = await drive.files.list({
    q: `trashed = false and name contains '${escapeForDriveQuery(query)}'`,
    fields: "files(id, name, mimeType, webViewLink, webContentLink)",
    pageSize: limit,
  });

  const files = res.data.files ?? [];
  if (files.length === 0) {
    logger.warn("drive.no_match", { query });
  }

  const results: DriveFileResult[] = [];
  for (const file of files) {
    if (!file.id || !file.name) continue;
    const link = await ensurePublicLink(file.id);
    results.push({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType ?? undefined,
      downloadUrl: link,
    });
  }
  return results;
}

const ZONAPROP_LINKS_FILE_NAME = "Links Zonaprop";

/**
 * Busca el link de Zonaprop de una propiedad/emprendimiento en un archivo
 * de texto simple en Drive (una lista a mano tipo "nombre,link" por línea,
 * ver docs/SETUP.md) — Tokko no expone ese link por API, es de Zonaprop.
 * Devuelve null si no existe el archivo o no hay ninguna línea que
 * coincida con `query`.
 */
export async function findZonapropLink(query: string): Promise<string | null> {
  // Búsqueda directa (sin pasar por findFilesByName) para no hacer público
  // por accidente un archivo que es solo para uso interno del agente.
  const list = await drive.files.list({
    q: `trashed = false and name contains '${escapeForDriveQuery(ZONAPROP_LINKS_FILE_NAME)}'`,
    fields: "files(id)",
    pageSize: 1,
  });
  const fileId = list.data.files?.[0]?.id;
  if (!fileId) return null;

  const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "text" });
  const content = res.data as unknown as string;

  const needle = query.trim().toLowerCase();
  for (const line of content.split("\n")) {
    const commaIndex = line.indexOf(",");
    if (commaIndex === -1) continue;
    const name = line.slice(0, commaIndex).trim();
    const link = line.slice(commaIndex + 1).trim();
    if (name.toLowerCase().includes(needle) && link) return link;
  }
  return null;
}

/**
 * Asegura que el archivo sea accesible por link (lector para "cualquiera con
 * el link") y devuelve una URL de descarga directa apta para adjuntar en
 * WhatsApp. Nota: esto solo aplica a archivos binarios reales (PDF, imágenes,
 * etc.) subidos a Drive — los Google Docs/Sheets nativos no sirven un link de
 * descarga directa utilizable como adjunto de WhatsApp sin exportarlos antes.
 */
export async function ensurePublicLink(fileId: string): Promise<string> {
  try {
    await drive.permissions.create({
      fileId,
      requestBody: { role: "reader", type: "anyone" },
    });
  } catch (error) {
    logger.warn("drive.permission_create_failed", { fileId, error: String(error) });
  }

  const meta = await drive.files.get({
    fileId,
    fields: "webContentLink, webViewLink",
  });
  return meta.data.webContentLink ?? meta.data.webViewLink ?? "";
}
