import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiProxyTarget = env.VITE_API_PROXY_TARGET || env.BACKEND_URL || 'http://localhost:3000';
  const apiProxyHost = new URL(apiProxyTarget).host;

  return {
    root: 'src',
    publicDir: '../public',
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: apiProxyTarget,
          changeOrigin: true,
          cookieDomainRewrite: {
            [apiProxyHost]: 'localhost'
          },
          // Forward cookies from backend to browser correctly
          configure: (proxy) => {
            proxy.on('proxyRes', (proxyRes) => {
              const setCookie = proxyRes.headers['set-cookie'];
              if (setCookie) {
                proxyRes.headers['set-cookie'] = setCookie.map(cookie =>
                  cookie.replace(/; *[Ss]ecure/g, '')
                        .replace(/[Ss]ameSite=None/gi, 'SameSite=Lax')
                );
              }
            });
          },
        },
      },
    },
    build: {
      outDir: '../dist',
      emptyOutDir: true,
    },
  };
});
