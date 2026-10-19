// This dataset is CC BY-NC-SA 3.0 (TeleGeography Submarine Cable Map), not the project's MIT license.
// Rather than bundling NonCommercial data in the repository, Mnemosyne OS Argus fetches it directly
// from upstream only after the user explicitly accepts the CC BY-NC-SA 3.0 license for personal use.

const UPSTREAM_BASE =
  'https://raw.githubusercontent.com/bilawalsidhu/gods-eye-view/main/src/data/local_data/telegeography_submarine_cables';
export const LICENSE_STORAGE_KEY = 'mnemo.argus.licensePacks.v1';

export function isCableLicenseAccepted() {
  try {
    const raw = localStorage.getItem(LICENSE_STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return Boolean(parsed && parsed.cables);
  } catch {
    return false;
  }
}

export function setCableLicenseAccepted(accepted) {
  try {
    const raw = localStorage.getItem(LICENSE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    parsed.cables = Boolean(accepted);
    localStorage.setItem(LICENSE_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    /* ignore storage errors */
  }
}

function cableUrl() {
  return `${UPSTREAM_BASE}/cable-geo.json`;
}

function landingPointUrl() {
  return `${UPSTREAM_BASE}/landing-point-geo.json`;
}

/** Supply GeoJSON collections without coupling the renderer to asset URLs. */
export function createBundledCableSource({
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  async function read(url, signal) {
    signal?.throwIfAborted();
    const response = await fetchImpl(url, { signal, cache: 'force-cache' });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        /* best effort */
      }
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    const json = await response.json();
    signal?.throwIfAborted();
    return json;
  }
  return {
    label: 'TeleGeography (CC BY-NC-SA 3.0)', // i18n-ignore: data provider name
    async fetch(signal) {
      if (!isCableLicenseAccepted()) {
        if (typeof window !== 'undefined' && typeof window.__mnemoOpenLicenseModal === 'function') {
          window.__mnemoOpenLicenseModal('cables');
        }
        throw new Error(
          'TeleGeography Submarine Cables requires user acceptance of the CC BY-NC-SA 3.0 license.',
        );
      }
      const [cables, landingPoints] = await Promise.all([
        read(cableUrl(), signal),
        read(landingPointUrl(), signal),
      ]);
      return { cables, landingPoints };
    },
  };
}
