/** Public origin of the app, e.g. https://ops.ecom.deltalabs.tech. Set APP_URL in production. */
export const APP_URL = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");

export function appUrl(path = "/"): string {
  return `${APP_URL}${path.startsWith("/") ? path : `/${path}`}`;
}
