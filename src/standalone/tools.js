import { createAssetDirectorySource } from '../director/packs/source.js';
import { createApplicationTools } from '../app/tools.js';
import { startStandaloneChrome } from './startupChrome.js';
import { loadToolCatalog } from './toolCatalog.js';

/**
 * Directory URL for director pack assets.
 * A leading `/scene-assets/` is fine on http(s), but under `mnemo-plugin://app/<id>/…`
 * it collapses to `mnemo-plugin://app/scene-assets/` and loses the cartridge id
 * (URL path resolution for non-special schemes). `./scene-assets/` keeps it.
 */
export function sceneAssetsBaseUrl(
  pageBase = globalThis.GEV_APP_BASE_URL ?? globalThis.document?.baseURI,
) {
  if (!pageBase) throw new TypeError('scene-assets base URL is missing');
  return new URL('./scene-assets/', pageBase).href;
}

export function createStandaloneTools(options) {
  return createApplicationTools({
    startChrome: startStandaloneChrome,
    sceneDataPacks: {
      sources: {
        assets: createAssetDirectorySource({
          // A panel names the app's address; see src/tools/globePanel.js.
          baseUrl: sceneAssetsBaseUrl(),
        }),
      },
    },
    ...options,
    voice: {
      supportedProviders: ['openai', 'gemini'],
      panel: true,
      toolCatalog: loadToolCatalog,
      ...options?.voice,
    },
  });
}
