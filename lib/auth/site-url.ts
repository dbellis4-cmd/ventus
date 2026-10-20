import "server-only";

export function getSiteUrl() {
  const value = process.env.SITE_URL || (process.env.NODE_ENV === "development" ? "http://localhost:3000" : "");
  const url = new URL(value);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("SITE_URL must be the application's HTTPS origin (HTTP is allowed on localhost).");
  }
  return url.origin;
}

export function isValidActionOrigin(origin: string | null, host: string | null): boolean {
  const siteUrl = getSiteUrl();
  if (process.env.NODE_ENV !== "development" || !origin) return origin === siteUrl;
  try {
    const url = new URL(origin);
    if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
      return url.origin === origin && url.host === host;
    }
    return origin === siteUrl;
  } catch {
    return false;
  }
}
