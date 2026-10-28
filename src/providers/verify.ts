import { PromptdiffError } from "../errors.js";

/**
 * Calls a free "list models" endpoint to check that a key is accepted.
 * Throws a PromptdiffError for rejected keys; network problems are rethrown as-is.
 */
export async function verifyWithRequest(
  url: string,
  headers: Record<string, string>,
  providerName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (res.ok) return;
  if (res.status === 401 || res.status === 403) {
    throw new PromptdiffError(`${providerName} rejected this key (HTTP ${res.status}).`, {
      hint: "Check you copied the whole key, and that it hasn't been revoked.",
    });
  }
  throw new PromptdiffError(`Couldn't verify the key: ${providerName} returned HTTP ${res.status}.`);
}
