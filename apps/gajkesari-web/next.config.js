/** @type {import('next').NextConfig} */
const path = require("node:path");

const nextConfig = {
  turbopack: {
    root: path.join(__dirname, "../.."),
  },
};

module.exports = nextConfig;
