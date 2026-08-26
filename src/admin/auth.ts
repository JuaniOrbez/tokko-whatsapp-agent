import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";

/**
 * Login por contraseña con sesión en cookie firmada (HMAC), sin store del
 * lado del servidor — alcanza para un solo panel de administración de una
 * sola inmobiliaria. La contraseña sigue siendo ADMIN_PASSWORD del .env.
 */
const COOKIE_NAME = "admin_session";
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const PUBLIC_PATHS = new Set(["/admin/login"]);

function sign(value: string): string {
  return crypto.createHmac("sha256", config.ADMIN_PASSWORD ?? "").update(value).digest("hex");
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function createSessionToken(): string {
  const expiry = Date.now() + SESSION_DURATION_MS;
  return `${expiry}.${sign(String(expiry))}`;
}

function isValidSessionToken(token: string | undefined): boolean {
  if (!token) return false;
  const dotIndex = token.indexOf(".");
  if (dotIndex === -1) return false;
  const expiryStr = token.slice(0, dotIndex);
  const signature = token.slice(dotIndex + 1);
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || Date.now() > expiry) return false;
  return timingSafeStringEqual(signature, sign(expiryStr));
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  if (!config.ADMIN_PASSWORD) {
    res
      .status(503)
      .send("Panel de administración no configurado — falta ADMIN_PASSWORD en el .env del servidor.");
    return;
  }
  // req.path acá viene relativo al prefijo "/admin" con el que se montó
  // este middleware (Express se lo saca) — hay que comparar contra
  // originalUrl, que sí mantiene el path completo, o esto nunca matchea y
  // /admin/login termina redirigiendo a sí mismo en loop.
  const pathname = req.originalUrl.split("?")[0];
  if (PUBLIC_PATHS.has(pathname)) {
    next();
    return;
  }

  const cookies = parseCookies(req);
  if (!isValidSessionToken(cookies[COOKIE_NAME])) {
    const nextParam =
      req.originalUrl && req.originalUrl !== "/admin" ? `?next=${encodeURIComponent(req.originalUrl)}` : "";
    res.redirect(`/admin/login${nextParam}`);
    return;
  }
  next();
}

export function checkPassword(password: string): boolean {
  return timingSafeStringEqual(password, config.ADMIN_PASSWORD ?? "");
}

export function setSessionCookie(res: Response): void {
  const token = createSessionToken();
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_DURATION_MS / 1000)}; Path=/admin`,
  );
}

export function clearSessionCookie(res: Response): void {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/admin`);
}
