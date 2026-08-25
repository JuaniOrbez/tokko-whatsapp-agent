import { google } from "googleapis";
import { config } from "../config.js";
import { getSettings } from "../settings.js";
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

const MAX_FOLDERS_SCANNED = 50;

/**
 * Junta el ID de `rootId` más el de todas sus subcarpetas (recorrido en
 * ancho, con un tope) — Drive no tiene una forma nativa de decir "busca
 * recursivo", hay que armar la lista de carpetas a mano.
 */
async function collectFolderIds(rootId: string): Promise<string[]> {
  const ids = [rootId];
  const queue = [rootId];
  while (queue.length > 0 && ids.length < MAX_FOLDERS_SCANNED) {
    const parent = queue.shift()!;
    const res = await drive.files.list({
      q: `trashed = false and mimeType = 'application/vnd.google-apps.folder' and '${parent}' in parents`,
      fields: "files(id)",
      pageSize: 100,
    });
    for (const folder of res.data.files ?? []) {
      if (folder.id && !ids.includes(folder.id)) {
        ids.push(folder.id);
        queue.push(folder.id);
      }
    }
  }
  return ids;
}

/**
 * Devuelve el fragmento de query para restringir la búsqueda a la carpeta
 * configurada en /admin (y sus subcarpetas), o "" si no hay ninguna
 * configurada (en ese caso se busca en todo lo que la cuenta de servicio
 * tenga compartido).
 */
async function parentsClause(): Promise<string> {
  const folderId = getSettings().driveFolderId;
  if (!folderId) return "";
  const folderIds = await collectFolderIds(folderId);
  return ` and (${folderIds.map((id) => `'${id}' in parents`).join(" or ")})`;
}

/**
 * Busca archivos por nombre (contiene) dentro de la carpeta configurada en
 * /admin (y sus subcarpetas) — o en todo lo que la cuenta de servicio
 * puede ver si no hay ninguna carpeta configurada.
 */
export async function findFilesByName(query: string, limit = 5): Promise<DriveFileResult[]> {
  const res = await drive.files.list({
    q: `trashed = false and name contains '${escapeForDriveQuery(query)}'${await parentsClause()}`,
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

/**
 * Busca el link de Zonaprop de una propiedad/emprendimiento en un archivo
 * de texto simple en Drive (una lista a mano tipo "nombre,link" por línea,
 * ver docs/SETUP.md) — Tokko no expone ese link por API, es de Zonaprop.
 * El nombre del archivo se configura desde /admin (getSettings().zonapropLinksFileName).
 * Devuelve null si no existe el archivo o no hay ninguna línea que
 * coincida con `query`.
 */
export async function findZonapropLink(query: string): Promise<string | null> {
  // Búsqueda directa (sin pasar por findFilesByName) para no hacer público
  // por accidente un archivo que es solo para uso interno del agente.
  const fileName = getSettings().zonapropLinksFileName;
  const list = await drive.files.list({
    q: `trashed = false and name contains '${escapeForDriveQuery(fileName)}'${await parentsClause()}`,
    fields: "files(id, mimeType)",
    pageSize: 1,
  });
  const file = list.data.files?.[0];
  if (!file?.id) return null;

  // Un Google Doc/Sheet nativo no se puede descargar con alt=media (da 403
  // "Only files with binary content..."), hay que exportarlo a texto plano.
  // El mimeType de exportación soportado difiere entre Doc y Sheet.
  let content: string;
  if (file.mimeType === "application/vnd.google-apps.spreadsheet") {
    const res = await drive.files.export(
      { fileId: file.id, mimeType: "text/csv" },
      { responseType: "text" },
    );
    content = res.data as unknown as string;
  } else if (file.mimeType?.startsWith("application/vnd.google-apps")) {
    const res = await drive.files.export(
      { fileId: file.id, mimeType: "text/plain" },
      { responseType: "text" },
    );
    content = res.data as unknown as string;
  } else {
    const res = await drive.files.get({ fileId: file.id, alt: "media" }, { responseType: "text" });
    content = res.data as unknown as string;
  }

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
