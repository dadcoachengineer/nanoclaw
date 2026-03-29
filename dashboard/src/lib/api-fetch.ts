/**
 * Wrapper around fetch that handles 401 by redirecting to login.
 * Use this for all authenticated API calls in the dashboard.
 */
export async function apiFetch(
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  const resp = await fetch(input, init);
  if (resp.status === 401) {
    if (typeof window !== "undefined") {
      window.location.href = "/login";
    }
    throw new Error("Unauthorized");
  }
  return resp;
}
