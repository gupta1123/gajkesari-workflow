/** @type {import('next').NextConfig} */
// Next.js loads this configuration as CommonJS in production.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");

const nextConfig = {
  turbopack: {
    root: path.join(__dirname, "../.."),
  },
};

module.exports = nextConfig;
