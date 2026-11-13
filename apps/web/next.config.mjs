/** @type {import('next').NextConfig} */
export default {
  transpilePackages: ["@forms2apex/core"],
  serverExternalPackages: ["@anthropic-ai/sdk"],
  poweredByHeader: false,
};
