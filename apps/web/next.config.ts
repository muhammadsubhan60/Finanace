import type { NextConfig } from "next";

const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'" + (process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""),
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

// Public host (e.g. ops.ecom.deltalabs.tech). Server actions reject mutations whose Origin isn't this host.
const appHost = process.env.APP_URL ? new URL(process.env.APP_URL).host : undefined;

const config: NextConfig = {
  transpilePackages: ["@delta/core", "@delta/db", "@delta/config-schema", "@delta/integrations"],
  serverExternalPackages: ["mongodb"],
  experimental: { serverActions: { bodySizeLimit: "10mb", ...(appHost ? { allowedOrigins: [appHost] } : {}) } },
  async headers() {
    return [{ source: "/(.*)", headers: [
      { key: "Content-Security-Policy", value: csp },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "same-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      { key: "X-Robots-Tag", value: "noindex, nofollow" },
      ...(process.env.NODE_ENV === "production" ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }] : []),
    ] }];
  },
};
export default config;
