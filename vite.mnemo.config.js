// The Mnemosyne OS cartridge server (`npm run dev:cartridge`): upstream's
// standalone config with the headers a Mnemosyne window needs (src/mnemo/hostFraming.js).
import { defineConfig } from 'vite';
import standalone from './server/standalone/vite.config.js';
import { hostHeaders } from './src/mnemo/hostFraming.js';

export default defineConfig(async (env) => {
  const config = await (typeof standalone === 'function' ? standalone(env) : standalone);
  return {
    ...config,
    server: { ...config.server, headers: hostHeaders(config.server?.headers) },
    preview: { ...config.preview, headers: hostHeaders(config.preview?.headers) },
  };
});
