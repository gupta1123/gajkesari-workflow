export const LOCAL_USER_ID = "local-dev-user";

export function isLocalDbMode() {
  return process.env.LOCAL_DB_MODE === "true";
}
