import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { calendar } from "@googleapis/calendar";
import { OAuth2Client } from "google-auth-library";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getSiteUrl } from "@/lib/auth/site-url";
import { requireSupabaseConfig } from "@/lib/supabase/config";

export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for Google Calendar`);
  return value;
}

export function oauthClient() {
  return new OAuth2Client(required("GOOGLE_CLIENT_ID"), required("GOOGLE_CLIENT_SECRET"),
    `${getSiteUrl()}/api/google/callback`);
}

export function calendarClient(auth: OAuth2Client) { return calendar({ version: "v3", auth }); }

export function serviceClient() {
  const { url } = requireSupabaseConfig();
  return createSupabaseClient(url, required("SUPABASE_SECRET_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function key() {
  const decoded = Buffer.from(required("GOOGLE_TOKEN_ENCRYPTION_KEY"), "base64");
  if (decoded.length !== 32) throw new Error("GOOGLE_TOKEN_ENCRYPTION_KEY must encode 32 bytes");
  return decoded;
}

export function encryptToken(token: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${encrypted.toString("base64")}:${cipher.getAuthTag().toString("base64")}`;
}

export function decryptToken(value: string) {
  const [version, iv, encrypted, tag] = value.split(":");
  if (version !== "v1" || !iv || !encrypted || !tag) throw new Error("Invalid stored Google token");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
}
