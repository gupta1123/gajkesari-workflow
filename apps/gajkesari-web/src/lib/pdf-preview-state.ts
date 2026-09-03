export function pdfPreviewNotice({ checking, required, verified, error }: {
  checking: boolean; required: boolean; verified: boolean; error: string | null;
}) {
  if (checking) return "checking";
  if (required) return verified ? "unlocked" : "password";
  return error ? "error" : "none";
}

// File changes and retries supersede old requests, even if abort arrives late.
export function createPdfPreviewRequestGate() {
  let active: AbortController | null = null;
  return {
    cancel() { active?.abort(); active = null; },
    begin() {
      active?.abort();
      const controller = new AbortController();
      active = controller;
      return {
        signal: controller.signal,
        isCurrent: () => active === controller && !controller.signal.aborted,
      };
    },
  };
}
