/**
 * Layers a Hub install cannot feed, said so on the layer itself.
 *
 * God's Eye View fetches most live feeds through its own same-origin `/api`
 * server (`server/providers/*`), which Vite serves in development. A Hub
 * install is static files under `mnemo-plugin://`: there is no server, and the
 * host refuses on purpose to spawn one for a Hub cartridge. Each of these
 * layers used to turn on and sit in red "UNAVAILABLE HTTP 404" (2026-11-06).
 *
 * Two holds, both from `src/mnemo/` without touching an upstream file:
 * - the layer's source availability reads `available: false` with a sentence
 *   in the host language, so the layer panel greys the row and names why
 *   before anyone clicks, and LayerLifecycle refuses the turn-on itself;
 * - a visibility guard refusing the same turn-on, should an upstream merge
 *   rename the availability seam.
 */
import { installLifecycleGuard } from './cableLayerGate.js';

/**
 * Catalog layer ids whose data only comes through GEV's `/api` server.
 * Checked against the catalog by hubApiLayerGate.test.mjs, so a typo cannot
 * quietly exempt a layer. Layers reading a public service or a bundled file
 * directly (earthquakes, air-quality, recent-imagery, cables, dams,
 * datacenters, sea marks, ski pistes, Bhote Koshi, street-level through
 * Panoramax) stay out.
 */
export const HUB_API_LAYER_IDS = Object.freeze([
  'flights', // /api/flights
  'military', // /api/military
  'ais-live-vessels', // /api/vessels
  'cctv', // /api/cctv
  'satellites', // /api/celestrak
  'rocket-launches', // /api/launches, /api/celestrak
  'weather-radar', // /api/weather
  'weather-satellite', // /api/weather
  'weather-lightning', // /api/weather
  'weather-cyclones', // /api/cyclones
  'wind', // /api/wind
  'local-firms', // /api/firms
  'fire-perimeters', // /api/fire-perimeters
  'gnss-integrity', // /api/gnss-integrity
  's2-ghostmaps', // /api/ghostmaps
  'drone-airspace', // /api/drone-airspace
  'radio', // /api/radio
  'traffic', // /api/tomtom
  'bikeshare', // /api/gbfs
  'transit', // /api/transit
  'military-installations', // /api/military-installations
  'alpr-cameras', // /api/overpass
  'directions', // /api/route
  'osm-places', // /api/osm/features
  'local-adsb', // /api/local-receivers
]);

const HUB_API_LAYERS = new Set(HUB_API_LAYER_IDS);

/** Source name carried by the availability, for anyone reading it in devtools. */
export const HUB_API_SOURCE = 'mnemosyne-hub-install';

/**
 * The availability a Hub install gives one layer, or null when this gate has
 * nothing to say about it (not a Hub install, or a layer that needs no server).
 * @param {string} layerId
 * @param {{ isHub: () => boolean, reason: () => string }} deps
 * @returns {{available: false, source: string, reason: string}|null}
 */
export function hubApiAvailability(layerId, { isHub, reason }) {
  if (!HUB_API_LAYERS.has(layerId) || !isHub()) return null;
  return Object.freeze({
    available: false,
    source: HUB_API_SOURCE,
    reason: reason(),
  });
}

/**
 * A visibility guard refusing to turn a server-backed layer on in a Hub
 * install. Turning one off is never refused.
 * @param {{ isHub: () => boolean, reason: () => string }} deps
 * @returns {(change: {layerId: string, enabled: boolean}) => (string|null)}
 */
export function createHubApiLayerGuard(deps) {
  return (change) => {
    if (!change?.enabled) return null;
    return hubApiAvailability(change.layerId, deps)?.reason || null;
  };
}

/**
 * Installs both holds on LayerLifecycle. Installed once per class.
 * @param {{ prototype: object }} LifecycleClass
 * @param {{ isHub: () => boolean, reason: () => string }} deps
 * @returns {{ availability: boolean, guard: boolean }} which hold is on.
 */
export function installHubApiLayerGate(LifecycleClass, deps) {
  const proto = LifecycleClass?.prototype;
  let availability = false;
  if (typeof proto?._sourceAvailability === 'function') {
    if (!proto.__mnemoHubAvailabilityInstalled) {
      const upstream = proto._sourceAvailability;
      proto._sourceAvailability = function hubAwareSourceAvailability(
        layerId,
        ...rest
      ) {
        return (
          hubApiAvailability(layerId, deps) ??
          upstream.call(this, layerId, ...rest)
        );
      };
      Object.defineProperty(proto, '__mnemoHubAvailabilityInstalled', {
        value: true,
      });
    }
    availability = true;
  } else {
    console.error(
      '[gods-eye-view] LayerLifecycle has no _sourceAvailability: in a Hub install the server-backed layers are refused but no longer greyed in the layer panel',
    );
  }
  const guard = installLifecycleGuard(
    LifecycleClass,
    createHubApiLayerGuard(deps),
    {
      marker: '__mnemoHubApiGuardInstalled',
      whatIsLost:
        'in a Hub install the server-backed layers are NOT refused on the layer panel',
    },
  );
  return { availability, guard };
}
