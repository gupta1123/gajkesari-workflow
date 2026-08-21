import { spawn, spawnSync } from "node:child_process";
import net from "node:net";

const serviceDefinitions = [
  ["frontend", "npm run start --workspace @gajkesari/web -- -p 3000", 3000],
  ["api", "npm run start --workspace @gajkesari/api", 3001],
  ["worker", "npm run worker:local --workspace @gajkesari/api"],
  ["tally-live-gateway", "npm run start --workspace @gajkesari/tally-live-gateway", 3002],
];

function portIsListening(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (listening) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

const services = [];
for (const [name, command, port] of serviceDefinitions) {
  if (port && await portIsListening(port)) {
    console.log(`[${name}] already listening on :${port}; reusing it.`);
    continue;
  }
  services.push([name, command]);
}

const children = new Map();
let shuttingDown = false;

function stopProcessTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  child.kill("SIGTERM");
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children.values()) stopProcessTree(child);
  process.exit(exitCode);
}

for (const [name, command] of services) {
  const child = process.platform === "win32"
    ? spawn("cmd.exe", ["/d", "/s", "/c", command], {
        cwd: process.cwd(),
        env: process.env,
        stdio: "inherit",
      })
    : spawn("sh", ["-c", command], {
        cwd: process.cwd(),
        env: process.env,
        stdio: "inherit",
      });

  children.set(name, child);
  child.once("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`[${name}] stopped${signal ? ` (${signal})` : ` with code ${code ?? 1}`}.`);
    shutdown(code || 1);
  });
}

console.log("Gajkesari production stack starting: frontend :3000, API :3001, Tally live gateway :3002, and worker.");

process.once("SIGINT", () => shutdown());
process.once("SIGTERM", () => shutdown());
