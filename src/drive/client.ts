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

/** Busca archivos por nombre (contiene) dentro de la carpeta configurada. */
export async function findFilesByName(query: string, limit = 5): Promise<DriveFileResult[]> {
  const parts = [`trashed = false`, `name contains '${escapeForDriveQuery(query)}'`];
  if (config.GOOGLE_DRIVE_FOLDER_ID) {
    parts.push(`'${config.GOOGLE_DRIVE_FOLDER_ID}' in parents`);
  }

  const res = await drive.files.list({
    q: parts.join(" and "),
    fields: "files(id, name, mimeType, webViewLink, webContentLink)",
    pageSize: limit,
  });

  const files = res.data.files ?? [];
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
