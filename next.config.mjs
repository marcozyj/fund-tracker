/** @type {import('next').NextConfig} */
const repoName = "fund-tracker";
const isGithubPages = process.env.GITHUB_ACTIONS === "true";

const nextConfig = {
  reactStrictMode: true,
  output: "export",
  trailingSlash: true,
  basePath: isGithubPages ? `/${repoName}` : "",
  assetPrefix: isGithubPages ? `/${repoName}/` : "",
  images: {
    unoptimized: true
  },
  devIndicators: {
    buildActivity: false,
    appIsrStatus: false
  }
};

export default nextConfig;
