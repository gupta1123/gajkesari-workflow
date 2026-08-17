function normalizeApiTarget(value) {
  const normalized = value && value.trim().replace(/\/+$/, "");
  if (!normalized) {
    return null;
  }

  return normalized.replace(/\/api$/i, "");
}

module.exports = {
  onPreBuild({ netlifyConfig, utils }) {
    const target =
      normalizeApiTarget(process.env.API_PROXY_TARGET) ||
      normalizeApiTarget(process.env.NEXT_PUBLIC_API_BASE_URL);

    if (!target) {
      utils.build.failBuild(
        "Missing API_PROXY_TARGET or NEXT_PUBLIC_API_BASE_URL. Netlify needs one of these to proxy /api/* to the backend."
      );
      return;
    }

    netlifyConfig.redirects = [
      {
        from: "/api/*",
        to: `${target}/api/:splat`,
        status: 200,
        force: true,
      },
      ...(netlifyConfig.redirects || []),
    ];
  },
};
