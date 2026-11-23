// Administrative enrollment. The day-to-day CLI only uses the paired operator credential.
import { createClient } from "@supabase/supabase-js";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { loadProfile, saveProfile, profilePath } from "./support-profile.mjs";
const id = process.argv[2];
if (!/^[0-9a-f-]{36}$/i.test(id || ""))
  throw Error("Provide the exact connection UUID to enroll.");
const env = process.env,
  url = env.NEXT_PUBLIC_SUPABASE_URL,
  key = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, options);
function checked(r) {
  if (r.error) throw Error(r.error.message);
  return r.data;
}
const device = checked(
  await admin
    .from("tally_connections")
    .select("installation_ref")
    .eq("id", id)
    .is("revoked_at", null)
    .single(),
);
if (!device.installation_ref) throw Error("Connection has no installation.");
if (!existsSync(profilePath())) {
  saveProfile({
    url,
    key,
    email: "support-cli-" + randomUUID() + "@gajkesari.invalid",
    password: randomBytes(48).toString("base64url"),
  });
}
const profile = loadProfile();
if (profile.url !== url) throw Error("Credential belongs to another project.");
const client = createClient(url, key, options);
const login = () =>
  client.auth.signInWithPassword({
    email: profile.email,
    password: profile.password,
  });
let session = await login();
if (session.error?.code === "invalid_credentials") {
  checked(
    await admin.auth.admin.createUser({
      email: profile.email,
      password: profile.password,
      email_confirm: true,
      app_metadata: { purpose: "connector-support-cli" },
    }),
  );
  session = await login();
}
const { user } = checked(session);
if (user.app_metadata?.purpose !== "connector-support-cli")
  throw Error("This is not an enrolled support identity.");
checked(
  await admin
    .from("connector_operator_grants")
    .upsert(
      { operator_id: user.id, installation_id: device.installation_ref },
      { onConflict: "operator_id,installation_id" },
    ),
);
console.log("CLI operator enrolled for connection", id);
