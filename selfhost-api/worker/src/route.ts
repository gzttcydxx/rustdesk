/**
 * Route table shape.
 *
 * Kept in its own module so the route files can import the type without
 * importing the router (which imports them).
 */

import type { Handler } from "./util";

export interface Route {
  method: string;
  /** Path without a leading slash. A `*` segment matches any one segment. */
  path: string;
  handler: Handler;
}

export interface MatchedRoute {
  route: Route;
  params: string[];
}

export function matchRoute(
  routes: Route[],
  method: string,
  segments: string[],
): MatchedRoute | null {
  let fallback: MatchedRoute | null = null;
  for (const route of routes) {
    const parts = route.path.split("/").filter(Boolean);
    if (parts.length !== segments.length) continue;
    const params: string[] = [];
    let ok = true;
    for (let i = 0; i < parts.length; i += 1) {
      if (parts[i] === "*") {
        params.push(segments[i]);
      } else if (parts[i] !== segments[i]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (route.method === method) return { route, params };
    // A path that matches but a method that does not still tells us the route
    // exists, which makes a 405 possible instead of a misleading 404.
    if (!fallback) fallback = { route, params };
  }
  return fallback;
}
