"use client";

import { useEffect } from "react";

/**
 * Global fetch interceptor that redirects to /login on 401 responses.
 * Prevents dashboard crashes when API routes reject unauthenticated requests.
 */
export function AuthInterceptor() {
  useEffect(() => {
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
      const resp = await originalFetch.apply(this, args);
      if (resp.status === 401) {
        const url = typeof args[0] === "string" ? args[0] : "";
        // Only redirect for our API routes, not external calls
        if (url.startsWith("/api/") && !url.startsWith("/api/auth/")) {
          window.location.href = "/login";
        }
      }
      return resp;
    };
    return () => {
      window.fetch = originalFetch;
    };
  }, []);

  return null;
}
