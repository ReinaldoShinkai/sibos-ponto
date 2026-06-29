/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    // face-api.js references Node.js built-ins (fs, canvas, encoding) as optional
    // dependencies; mark them as false/external so browser bundles don't fail.
    config.externals = [...(config.externals || []), { canvas: 'canvas' }]
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      path: false,
      encoding: false,
    }
    return config
  },
}

export default nextConfig
