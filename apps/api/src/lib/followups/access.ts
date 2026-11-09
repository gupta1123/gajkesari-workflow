// Rollout gate for payment follow-ups. Fails closed: nobody can use the feature
// until FOLLOWUPS_ENABLED=true AND their user id is in FOLLOWUPS_ALLOWED_OWNERS
// (comma-separated; "*" opens it to every signed-in owner).

export function followupsEnabledFor(userId: string, env: Record<string, string | undefined> = process.env) {
  if (String(env.FOLLOWUPS_ENABLED ?? "").trim().toLowerCase() !== "true") return false;
  const allowed = String(env.FOLLOWUPS_ALLOWED_OWNERS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  return allowed.includes("*") || allowed.includes(userId);
}
