import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  ...(process.env.VENTUS_BROWSER_TEST ? { distDir: ".next-browser-test", allowedDevOrigins: ["127.0.0.1"] } : {}),
};

export default nextConfig;
