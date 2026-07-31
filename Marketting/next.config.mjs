import path from "node:path";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The Dejavu repo root has its own bun.lock; pin tracing to this app.
  outputFileTracingRoot: path.dirname(new URL(import.meta.url).pathname),
};

export default nextConfig;
