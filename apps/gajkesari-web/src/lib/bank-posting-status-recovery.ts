export class PostingStatusUnavailable extends Error {
  constructor() { super("Posting may still be running. Keep the connector open and resume the status check. Do not post again."); }
}

// Only status GETs use this helper. A lost response must never replay a POST.
export async function readPostingStatus<T>(read: () => Promise<Response>, options: {
  onReconnect?: () => void; attempts?: number; wait?: (ms: number) => Promise<void>;
} = {}): Promise<T> {
  const attempts = options.attempts ?? 8;
  const pause = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await read();
      if ([408, 429].includes(response.status) || response.status >= 500) throw new TypeError("Status connection unavailable");
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Could not read posting status (${response.status}).`);
      }
      return await response.json() as T;
    } catch (error) {
      if (!(error instanceof TypeError) && !(error instanceof SyntaxError) &&
        !(error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))) throw error;
      options.onReconnect?.();
      if (attempt === attempts - 1) throw new PostingStatusUnavailable();
      await pause(Math.min(1000 * 2 ** attempt, 5000));
    }
  }
  throw new PostingStatusUnavailable();
}
