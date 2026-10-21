import { MnemoCartridgeSDK } from '@mnemosyne_os/cartridge-sdk';
import { voiceLayerAliasMap } from '../voice/layerManifest.js';
import {
  cameraMoved,
  checkedResult,
  compactStatus,
  isFramedByHost,
  orbFailureKey,
  orbLabel,
  phrase,
  uiText,
} from './bridgeModel.js';
import {
  isCableLicenseAccepted,
  setCableLicenseAccepted,
} from './cableLicence.js';

// Must equal `name` in mnemo-plugin.json: the host drops every message whose
// pluginId differs from the id it registered (usePluginBridge.ts).
const sdk = new MnemoCartridgeSDK('@mnemosyne-plugins/mnemo-gods-eye-view');

/**
 * The text of a `sdk.query` reply. The host answers with one synthesized
 * answer (an inference over the memory), never a list of hits.
 */
function answerText(result) {
  if (result?.success === false)
    throw new Error(result.error || 'Memory did not answer');
  return String(
    result?.text ?? result?.response ?? result?.content ?? result?.answer ?? '',
  ).trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Writes screen text. GEV's icon check (materialSymbolsSubset.test) reads every
 * lowercase literal assigned to textContent as a Material Symbols glyph, and
 * ui('searching') is a text key, not an icon.
 */
function setText(el, text) {
  el.textContent = text;
}

/** The person's language, from the host's MNEMO_CONFIG_UPDATE (see phrase in bridgeModel). */
let hostLang = (typeof navigator !== 'undefined' && navigator.language) || 'en';

/** The assistant's given name, from the host's MNEMO_CONFIG_UPDATE; null until it says. */
let assistantName = null;

/** The camera's world position now, or null before the globe exists. */
function cameraPosition() {
  const p = window.__godsEyeView?.viewer?.camera?.positionWC;
  return p ? { x: p.x, y: p.y, z: p.z } : null;
}

/** Set once the globe has finished its start: later calls skip the wait. */
let gevSettled = false;

/**
 * Wait until the globe can be driven. The voice runner exists well before the
 * start is over: the start then restores the opening view and flies the
 * camera there. A flyTo sent in between was accepted, answered « ok », and
 * undone by that flight (2026-10-19: the orb said « Je vole vers Tokyo » and
 * the camera ended over Austin). So: the runner, then the start's own view
 * restore (the promise the loading screen waits for), then a camera that has
 * stopped moving.
 */
async function waitForGev(timeoutMs = 30000) {
  const start = Date.now();
  const left = () => timeoutMs - (Date.now() - start);
  let gev = null;
  while (left() > 0) {
    const g = window.__godsEyeView;
    if (g?.voiceCommands?.runner && g?.dataManager && g?.styleManager) {
      gev = g;
      break;
    }
    await sleep(120);
  }
  if (!gev)
    // NOT_READY is the host's word for « wait »: it asks again each second
    // within the call's budget, where a plain refusal paid a planner repair.
    throw new Error("NOT_READY: God's Eye View is still starting");
  if (gevSettled) return gev;

  const restore = gev.styleManager.initialRestorePromise;
  if (restore && typeof restore.then === 'function') {
    await Promise.race([
      restore.catch((err) => {
        // The start reports its own restore failure; the globe can still be driven.
        console.warn('[gods-eye-view] opening view restore failed:', err);
      }),
      sleep(Math.max(0, left())),
    ]);
  }
  // The opening flight: wait for three still readings in a row (600 ms).
  const camera = gev.viewer?.camera;
  if (camera?.positionWC) {
    let last = null;
    let still = 0;
    while (left() > 0 && still < 3) {
      const p = camera.positionWC;
      const now = { x: p.x, y: p.y, z: p.z };
      const moved = last
        ? Math.hypot(now.x - last.x, now.y - last.y, now.z - last.z)
        : Infinity;
      still = moved < 1 ? still + 1 : 0;
      last = now;
      await sleep(200);
    }
  }
  gevSettled = true;
  return gev;
}

/**
 * One God's Eye View voice tool, its answer passed on as is. The HUD buttons
 * use it and read the answer themselves; the agent door goes through
 * runChecked, which turns a refusal into a throw.
 */
async function runGevTool(actionName, args = {}) {
  const gev = await waitForGev();
  return gev.voiceCommands.runner(actionName, args);
}

/**
 * The flyTo arguments God's Eye View reads. No place named is a refusal:
 * this used to fly to New York, a place nobody said (verifier, 2026-10-20).
 */
function normalizeFlyToArgs(params = {}) {
  const rawId = String(params.locationId || '')
    .trim()
    .toLowerCase();
  const KNOWN_IDS = new Set([
    'austin',
    'sf',
    'nyc',
    'tokyo',
    'london',
    'paris',
    'dubai',
    'dc',
  ]);
  const ALIAS_MAP = {
    'new-york': 'nyc',
    newyork: 'nyc',
    manhattan: 'nyc',
    'san-francisco': 'sf',
    sanfrancisco: 'sf',
    washington: 'dc',
  };
  const range = params.rangeM ? { rangeM: Number(params.rangeM) } : {};
  const mappedId = ALIAS_MAP[rawId] || rawId;
  if (KNOWN_IDS.has(mappedId)) return { locationId: mappedId, ...range };
  if (
    typeof params.latitude === 'number' &&
    typeof params.longitude === 'number'
  ) {
    return { latitude: params.latitude, longitude: params.longitude, ...range };
  }
  const query = String(params.query || params.locationId || '').trim();
  if (!query) {
    throw new Error(
      'flyTo needs a place: locationId, query, or latitude and longitude',
    );
  }
  return { query, ...range };
}

// God's Eye View's own layer vocabulary (ids + spoken aliases). A second
// table here drifted: it sent "cables" to a layer id that never existed.
const LAYER_ALIASES = voiceLayerAliasMap();
const CABLES_LAYER_ID = 'telegeography-submarine-cables';

function normalizeLayerId(id) {
  const clean = String(id || '')
    .trim()
    .toLowerCase();
  return (
    LAYER_ALIASES.get(clean) ||
    LAYER_ALIASES.get(clean.replace(/[-_]+/g, ' ')) ||
    clean
  );
}

const OPTICS_ALIAS_MAP = {
  crt: 'retro',
  nvg: 'surveillance',
  flir: 'thermal',
};

function normalizeOpticsStyle(style) {
  const clean = String(style || 'normal')
    .trim()
    .toLowerCase();
  return OPTICS_ALIAS_MAP[clean] || clean;
}

/**
 * runGevTool for the agent door: God's Eye View answers a failure as a value
 * (`{ ok: false, error, say }`), and wrapping that in `{ ok: true }` told the
 * agent, and the orb after it, that a refused action had been done.
 */
async function runChecked(actionName, args = {}) {
  return checkedResult(await runGevTool(actionName, args), actionName);
}

/**
 * Frames this window painted per second, measured over `ms`. A window hidden
 * behind another one gets none: Chromium stops its frames, so a camera flight
 * is accepted and stays frozen until the window is seen again. An agent that
 * says « flying to Tokyo » while this reads 0 is telling the person something
 * they will not see happen.
 */
function measureFps(ms = 400) {
  return new Promise((resolve) => {
    let frames = 0;
    let id = 0;
    const t0 = performance.now();
    const tick = () => {
      frames++;
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    setTimeout(() => {
      cancelAnimationFrame(id);
      resolve(Math.round((frames * 1000) / (performance.now() - t0)));
    }, ms);
  });
}

/** Register Mnemosyne OS Agent Door actions. */
function registerMnemoAgentDoor() {
  return sdk.onAgentActions({
    // i18n-ignore: the agent door answers an agent, never the page
    status: async (params = {}) => {
      const gev = await waitForGev();
      const viewState = await gev.voiceCommands.runner(
        'get_current_view_state',
        {},
      );
      const entityCtx = await gev.voiceCommands.runner(
        'get_entity_context',
        {},
      );
      const licensePacks = {
        submarineCablesCcByNcSa30: isCableLicenseAccepted(),
      };
      // The full state is ~19 KB (~5,000 tokens) and an agent pays it on every
      // question; the default answers what a person asks about the view.
      if (params.full === true)
        return {
          app: "God's Eye View",
          viewState,
          entityContext: entityCtx,
          licensePacks,
        };
      return compactStatus(
        viewState,
        entityCtx,
        licensePacks,
        await measureFps(),
      );
    },

    flyTo: async (params = {}) => {
      const args = normalizeFlyToArgs(params);
      const before = cameraPosition();
      const res = await runChecked('fly_to_location', args);
      // An animated flight is frames: in a window hidden behind another one
      // it waits. A place set directly has already moved the camera, so the
      // notice is said only when nothing moved (measured 2026-10-19: a city
      // preset froze over Austin, « Londres » landed with 0 frames).
      const fps = await measureFps();
      const frozen = fps === 0 && !cameraMoved(before, cameraPosition());
      return {
        ok: true,
        action: 'fly_to_location',
        args,
        result: res,
        ...(frozen
          ? { onScreen: false, say: phrase('notOnScreen', hostLang) }
          : {}),
      };
    },

    setLayers: async (params = {}) => {
      const lid = normalizeLayerId(params.layerId);
      const enabled = params.enabled !== false;
      if (lid === CABLES_LAYER_ID && enabled && !isCableLicenseAccepted()) {
        // A refusal, said to the person: returned as a value it was counted
        // as done, kept as a recipe and replayed (verifier, 2026-10-20).
        window.__mnemoOpenLicenseModal?.('cables');
        throw new Error(`TO_PERSON: ${phrase('licenceWindow', hostLang)}`);
      }
      const res = await runChecked('set_layer_visibility', {
        layerId: lid,
        enabled,
      });
      return { ok: true, layerId: lid, enabled, result: res };
    },

    setOptics: async (params = {}) => {
      const style = normalizeOpticsStyle(params.style || 'normal');
      const res = await runChecked('set_visual_style', { style });
      return { ok: true, style, result: res };
    },

    controlCctv: async (params = {}) => {
      const action = String(params.action || 'nearest').trim();
      const res = await runChecked('control_cctv', {
        action,
        ...(params.cameraQuery
          ? { cameraQuery: String(params.cameraQuery) }
          : {}),
        ...(typeof params.enabled === 'boolean'
          ? { enabled: params.enabled }
          : {}),
      });
      return { ok: true, action, result: res };
    },

    controlRadio: async (params = {}) => {
      const action = String(params.action || 'enable').trim();
      const res = await runChecked('control_radio', {
        action,
        ...(params.stationQuery
          ? { stationQuery: String(params.stationQuery) }
          : {}),
      });
      return { ok: true, action, result: res };
    },

    selectNearestAircraft: async (params = {}) => {
      const where = {
        ...(params.locationId ? { locationId: String(params.locationId) } : {}),
        ...(params.locationQuery
          ? { locationQuery: String(params.locationQuery) }
          : {}),
      };
      // No place named: "the nearest aircraft" is the one nearest to what the
      // person is looking at, so the camera is the place.
      if (!where.locationId && !where.locationQuery) {
        const view = await runGevTool('get_current_view_state', {});
        const cam = view?.camera;
        if (
          cam &&
          Number.isFinite(cam.latitude) &&
          Number.isFinite(cam.longitude)
        ) {
          where.latitude = cam.latitude;
          where.longitude = cam.longitude;
        }
      }
      const res = await runChecked('select_nearest_aircraft', {
        layerId: params.layerId === 'military' ? 'military' : 'flights',
        ...where,
      });
      return { ok: true, result: res };
    },

    trackEntity: async (params = {}) => {
      if (params.stop) {
        const res = await runChecked('stop_tracking', {});
        return { ok: true, stopped: true, result: res };
      }
      const res = await runChecked('track_entity', {
        query: String(params.query || ''),
        ...(params.layerId
          ? { layerId: normalizeLayerId(params.layerId) }
          : {}),
      });
      return { ok: true, result: res };
    },

    controlCockpit: async (params = {}) => {
      const action = String(params.action || 'enter').trim();
      const res = await runChecked('control_cockpit', {
        action,
        ...(params.targetLayer
          ? { targetLayer: String(params.targetLayer) }
          : {}),
      });
      return { ok: true, action, result: res };
    },

    setCyberSonar: async (params = {}) => {
      const enabled = params.enabled !== false;
      const res = await runChecked('set_cyber_sonar', { enabled });
      return { ok: true, enabled, result: res };
    },

    setContextMode: async (params = {}) => {
      const mode = String(params.mode || 'contacts').trim();
      const res = await runChecked('set_context_mode', { mode });
      return { ok: true, mode, result: res };
    },

    showPanel: async (params = {}) => {
      const panelId = String(params.panelId || 'cctv-panel').trim();
      const open = params.open !== false;
      const res = await runChecked('set_panel_open', { panelId, open });
      return { ok: true, panelId, open, result: res };
    },

    // « scene » in an action id made the orb offer this globe for Vitrine
    // Studio's scenes; the director's shots are what this action plays.
    controlDirector: async (params = {}) => {
      const action = String(params.action || 'list').trim();
      const res = await runChecked('control_scene', {
        action,
        ...(params.sceneId ? { sceneId: String(params.sceneId) } : {}),
      });
      return { ok: true, action, result: res };
    },

    // An agent never accepts a licence for the person: this opens the
    // licence window and the person clicks. Turning the pack OFF is safe and
    // stays available to the agent.
    acceptLicensePack: async (params = {}) => {
      if (params.accept === false) {
        setCableLicenseAccepted(false);
        window.__mnemoSyncLicenseUi?.();
        await runGevTool('set_layer_visibility', {
          layerId: CABLES_LAYER_ID,
          enabled: false,
        });
        return {
          packId: 'cables',
          accepted: false,
          license: 'CC BY-NC-SA 3.0',
        };
      }
      if (isCableLicenseAccepted()) {
        await runChecked('set_layer_visibility', {
          layerId: CABLES_LAYER_ID,
          enabled: true,
        });
        return {
          packId: 'cables',
          accepted: true,
          license: 'CC BY-NC-SA 3.0',
        };
      }
      window.__mnemoOpenLicenseModal?.('cables');
      return {
        packId: 'cables',
        accepted: false,
        licenceWindowOpen: true,
        license: 'CC BY-NC-SA 3.0',
        say: phrase('licenceWindow', hostLang),
      };
    },

    queryMemory: async (params = {}) => {
      const q = String(params.query || '').trim();
      if (!q) throw new Error('queryMemory needs a question');
      // `sdk.query` takes the question only: the host decides which vaults
      // answer (the person's attention), and replies with one answer.
      const answer = answerText(await sdk.query(q));
      window.__mnemoShowMemoryResults?.(q, answer);
      return {
        ok: true,
        query: q,
        answer,
        empty: !answer,
      };
    },
  });
}

/** Inject Mnemosyne OS Liquid Glass Bridge UI (License Gate + Vault Memory Seam). */
/** Screen text in the person's language (see UI_TEXT). */
const ui = (key) => uiText(key, hostLang);

/** A HUD click handler whose failure is logged (the globe may still be starting). */
const logged = (name, fn) => async (ev) => {
  try {
    await fn(ev);
  } catch (err) {
    console.warn(`[gods-eye-view] ${name} failed:`, err);
  }
};

function mountMnemoHudOverlay() {
  if (document.getElementById('mnemo-argus-bridge')) return;

  // Inside Mnemosyne OS the microphone stays with the host (its frame only
  // allows fullscreen, doc 123): GEV's own voice agent could never hear, and
  // its 'permission denied' card hid the globe. The orb drives the globe
  // through the agent door instead, so the panel goes and a hint replaces it.
  const handVoiceToHost = isFramedByHost(window);
  if (handVoiceToHost) document.documentElement.dataset.gevVoice = 'off';

  const style = document.createElement('style');
  style.textContent = `
    /* Liquid glass, one line, icons with short words (style-cartouche):
       what is ON is green with a check dot, the orb is the green-tinted main
       action. Every colour is a token on the bar, so the modal keeps its own. */
    #mnemo-argus-bridge {
      --mb-fill: color-mix(in srgb, #fff 7%, transparent);
      --mb-fill-hover: color-mix(in srgb, #fff 13%, transparent);
      --mb-edge: color-mix(in srgb, #fff 16%, transparent);
      --mb-shine: color-mix(in srgb, #fff 24%, transparent);
      --mb-text: #e8eef6;
      --mb-muted: #93a3b8;
      --mb-chosen: #3fa66a;
      position: fixed;
      bottom: 14px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 9500;
      max-width: calc(100vw - 32px);
      overflow-x: auto;
      scrollbar-width: none;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px;
      border-radius: 999px;
      background: color-mix(in srgb, #08101c 62%, transparent);
      backdrop-filter: blur(20px) saturate(170%);
      -webkit-backdrop-filter: blur(20px) saturate(170%);
      border: 1px solid var(--mb-edge);
      box-shadow: inset 0 1px 0 var(--mb-shine), 0 14px 34px -12px rgba(0, 0, 0, 0.7);
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      color: var(--mb-text);
      pointer-events: auto;
      white-space: nowrap;
    }
    #mnemo-argus-bridge::-webkit-scrollbar { display: none; }
    .mnemo-bridge-brand {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 0 10px 0 8px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.04em;
      color: var(--mb-muted);
    }
    .mnemo-bridge-brand-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--mb-chosen);
      box-shadow: 0 0 8px var(--mb-chosen);
    }
    .mnemo-bridge-sep {
      width: 1px;
      height: 20px;
      background: var(--mb-edge);
      flex: none;
    }
    .mnemo-bridge-btn {
      appearance: none;
      position: relative;
      flex: none;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      height: 34px;
      padding: 0 14px 0 11px;
      border-radius: 999px;
      border: 1px solid var(--mb-edge);
      background: var(--mb-fill);
      box-shadow: inset 0 1px 0 var(--mb-shine);
      color: var(--mb-text);
      font: 600 12.5px/1 'Inter', system-ui, -apple-system, sans-serif;
      cursor: pointer;
      transition: background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
    }
    .mnemo-bridge-btn svg {
      width: 16px;
      height: 16px;
      flex: none;
      stroke: currentColor;
      fill: none;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
      opacity: 0.9;
    }
    .mnemo-bridge-btn:hover { background: var(--mb-fill-hover); }
    .mnemo-bridge-btn:focus-visible { outline: 2px solid var(--mb-chosen); outline-offset: 2px; }
    .mnemo-bridge-btn.active {
      background: color-mix(in srgb, var(--mb-chosen) 22%, var(--mb-fill));
      border-color: color-mix(in srgb, var(--mb-chosen) 70%, transparent);
      box-shadow: inset 0 1px 0 var(--mb-shine), 0 0 14px -4px var(--mb-chosen);
      color: #eafff1;
    }
    .mnemo-bridge-btn.active::after {
      content: '✓';
      position: absolute;
      top: -4px;
      right: -3px;
      width: 15px;
      height: 15px;
      border-radius: 50%;
      background: var(--mb-chosen);
      color: #fff;
      font-size: 9px;
      line-height: 15px;
      text-align: center;
      box-shadow: 0 0 0 2px #0b1320;
    }
    .mnemo-bridge-orb {
      background: color-mix(in srgb, var(--mb-chosen) 20%, var(--mb-fill));
      border-color: color-mix(in srgb, var(--mb-chosen) 55%, transparent);
    }
    .mnemo-bridge-orb:hover {
      background: color-mix(in srgb, var(--mb-chosen) 30%, var(--mb-fill));
    }
    .mnemo-bridge-orb-dot {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: radial-gradient(circle at 35% 30%, #d9fbe8 0%, #5fd393 38%, #1f7a4b 100%);
      box-shadow: 0 0 10px #4ade80;
      flex: none;
    }
    .mnemo-bridge-orb[data-state='calling'] .mnemo-bridge-orb-dot {
      animation: mnemo-orb-pulse 0.9s ease-in-out infinite;
    }
    .mnemo-bridge-orb[data-state='failed'] {
      background: color-mix(in srgb, #e5484d 18%, var(--mb-fill));
      border-color: color-mix(in srgb, #e5484d 55%, transparent);
    }
    @keyframes mnemo-orb-pulse {
      50% { transform: scale(0.72); opacity: 0.6; }
    }
    @media (prefers-reduced-motion: reduce) {
      .mnemo-bridge-orb[data-state='calling'] .mnemo-bridge-orb-dot { animation: none; }
    }
    /* The licence modal's tag keeps this pill. */
    .mnemo-bridge-badge {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: #34d399;
      padding: 2px 7px;
      border-radius: 999px;
      background: rgba(16, 185, 129, 0.14);
      border: 1px solid rgba(16, 185, 129, 0.35);
    }
    /* GEV's own dock (location, visual presets) sits on the same bottom
       line: lift it above this bar instead of hiding it under. */
    #command-dock {
      bottom: 72px !important;
    }
    html[data-gev-voice='off'] #gev-voice-control {
      display: none !important;
    }
    #mnemo-argus-modal-backdrop {
      position: fixed;
      inset: 0;
      z-index: 10000;
      background: rgba(3, 6, 12, 0.72);
      backdrop-filter: blur(8px);
      display: none;
      align-items: center;
      justify-content: center;
      padding: 20px;
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
    }
    #mnemo-argus-modal-backdrop.open {
      display: flex;
    }
    .mnemo-modal-card {
      width: 100%;
      max-width: 520px;
      border-radius: 16px;
      padding: 22px;
      background: linear-gradient(145deg, rgba(14, 22, 36, 0.96) 0%, rgba(8, 13, 24, 0.98) 100%);
      border: 1px solid rgba(255, 255, 255, 0.16);
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.75);
      color: #f1f5f9;
    }
    .mnemo-modal-card h3 {
      margin: 0 0 6px 0;
      font-size: 16px;
      font-weight: 700;
      color: #ffffff;
    }
    .mnemo-modal-card p {
      margin: 0 0 12px 0;
      font-size: 12.5px;
      line-height: 1.55;
      color: #94a3b8;
    }
    .mnemo-license-box {
      padding: 12px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.1);
      margin-bottom: 14px;
    }
    .mnemo-action-primary {
      appearance: none;
      border: 1px solid rgba(52, 211, 153, 0.6);
      background: rgba(16, 185, 129, 0.22);
      color: #ecfdf5;
      font-weight: 600;
      font-size: 12px;
      padding: 8px 14px;
      border-radius: 10px;
      cursor: pointer;
    }
    .mnemo-action-secondary {
      appearance: none;
      border: 1px solid rgba(255, 255, 255, 0.16);
      background: rgba(255, 255, 255, 0.06);
      color: #cbd5e1;
      font-weight: 600;
      font-size: 12px;
      padding: 8px 14px;
      border-radius: 10px;
      cursor: pointer;
    }
    .mnemo-mem-input {
      width: 100%;
      box-sizing: border-box;
      padding: 8px 12px;
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.16);
      background: rgba(0, 0, 0, 0.35);
      color: #f8fafc;
      font-size: 12px;
      margin-bottom: 10px;
    }
    .mnemo-mem-results {
      max-height: 220px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 8px;
    }
    .mnemo-mem-hit {
      padding: 9px 11px;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.09);
      font-size: 11.5px;
      color: #cbd5e1;
    }
  `;
  document.head.appendChild(style);

  const bar = document.createElement('div');
  bar.id = 'mnemo-argus-bridge';
  bar.setAttribute('role', 'toolbar');
  // i18n-ignore: a product name
  bar.setAttribute('aria-label', 'Mnemosyne OS');
  // i18n-ignore: product names only (Mnemosyne OS); every label goes through ui()
  bar.innerHTML = `
    <span class="mnemo-bridge-brand" translate="no"><span class="mnemo-bridge-brand-dot"></span>Mnemosyne OS</span>
    <span class="mnemo-bridge-sep" aria-hidden="true"></span>
    <button type="button" class="mnemo-bridge-btn" id="mnemo-btn-radar" title="${ui('radarTitle')}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19 5a10 10 0 0 1 0 14M5 19A10 10 0 0 1 5 5"/></svg><span>${ui('live')}</span>
    </button>
    <button type="button" class="mnemo-bridge-btn" id="mnemo-btn-cockpit" title="${ui('cockpitTitle')}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/></svg><span>${ui('cockpit')}</span>
    </button>
    <button type="button" class="mnemo-bridge-btn" id="mnemo-btn-cables" title="${ui('cablesTitle')}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 15c3 0 3-6 6-6s3 6 6 6 3-6 6-6"/><path d="M3 20h18"/></svg><span>${ui('cables')}</span>
    </button>
    <button type="button" class="mnemo-bridge-btn" id="mnemo-btn-memory" title="${ui('memoryTitle')}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 3 3h1V3z"/><path d="M15 3a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-3 3h-1V3z"/></svg><span>${ui('memory')}</span>
    </button>
    ${
      handVoiceToHost
        ? `<span class="mnemo-bridge-sep" aria-hidden="true"></span>
    <button type="button" class="mnemo-bridge-btn mnemo-bridge-orb" id="mnemo-voice-orb" data-state="idle" title="${ui('orbTitle')}">
      <span class="mnemo-bridge-orb-dot" aria-hidden="true"></span><span class="mnemo-bridge-orb-label">${orbLabel(assistantName, hostLang)}</span>
    </button>`
        : ''
    }
  `;
  document.body.appendChild(bar);

  const backdrop = document.createElement('div');
  backdrop.id = 'mnemo-argus-modal-backdrop';
  document.body.appendChild(backdrop);

  function closeModal() {
    backdrop.classList.remove('open');
    backdrop.innerHTML = '';
  }

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal();
  });

  function syncLicenseUi() {
    const btn = document.getElementById('mnemo-btn-cables');
    if (!btn) return;
    if (isCableLicenseAccepted()) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  }
  window.__mnemoSyncLicenseUi = syncLicenseUi;
  syncLicenseUi();

  window.__mnemoOpenLicenseModal = () => {
    const accepted = isCableLicenseAccepted();
    // i18n-ignore: proper names only (the map, its licence); every sentence goes through ui()
    backdrop.innerHTML = `
      <div class="mnemo-modal-card">
        <h3><span aria-hidden="true">📜</span> ${ui('licenceHeading')}</h3>
        <p>${ui('licenceBody')}</p>
        <div class="mnemo-license-box">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <strong style="font-size:13px;" translate="no">TeleGeography Submarine Cable Map</strong>
            <span class="mnemo-bridge-badge" translate="no">CC BY-NC-SA 3.0</span>
          </div>
          <p style="margin:0;font-size:11.5px;">${ui('licenceSource')}</p>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:10px;">
          <button type="button" class="mnemo-action-secondary" id="mnemo-modal-close">${ui('close')}</button>
          ${
            accepted
              ? `<button type="button" class="mnemo-action-secondary" id="mnemo-license-revoke">${ui('revoke')}</button>`
              : `<button type="button" class="mnemo-action-primary" id="mnemo-license-accept">${ui('accept')}</button>`
          }
        </div>
      </div>
    `;
    backdrop.classList.add('open');
    document
      .getElementById('mnemo-modal-close')
      ?.addEventListener('click', closeModal);
    document.getElementById('mnemo-license-accept')?.addEventListener(
      'click',
      logged('licence accept', async () => {
        setCableLicenseAccepted(true);
        syncLicenseUi();
        closeModal();
        await runGevTool('set_layer_visibility', {
          layerId: CABLES_LAYER_ID,
          enabled: true,
        });
      }),
    );
    document.getElementById('mnemo-license-revoke')?.addEventListener(
      'click',
      logged('licence revoke', async () => {
        setCableLicenseAccepted(false);
        syncLicenseUi();
        closeModal();
        await runGevTool('set_layer_visibility', {
          layerId: CABLES_LAYER_ID,
          enabled: false,
        });
      }),
    );
  };

  function openMemoryModal(initialQuery = '', initialAnswer = null) {
    backdrop.innerHTML = `
      <div class="mnemo-modal-card">
        <h3>🧠 ${ui('memoryHeading')}</h3>
        <p>${ui('memoryIntro')}</p>
        <div style="display:flex;gap:8px;">
          <input type="text" class="mnemo-mem-input" id="mnemo-mem-q" placeholder="${ui('memoryPlaceholder')}" style="margin-bottom:0;flex:1;" />
          <button type="button" class="mnemo-action-primary" id="mnemo-mem-run">${ui('search')}</button>
        </div>
        <div class="mnemo-mem-results" id="mnemo-mem-list"></div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:14px;">
          <button type="button" class="mnemo-action-secondary" id="mnemo-mem-pin">📌 ${ui('pin')}</button>
          <button type="button" class="mnemo-action-secondary" id="mnemo-modal-close">${ui('close')}</button>
        </div>
      </div>
    `;
    backdrop.classList.add('open');
    // Set as a property, never spliced into the HTML: no escaping to get wrong.
    const input = document.getElementById('mnemo-mem-q');
    if (input) input.value = initialQuery;
    const listEl = document.getElementById('mnemo-mem-list');
    // `null` = nothing asked yet; '' = asked, and memory had nothing to say.
    const renderAnswer = (answer) => {
      if (!listEl) return;
      const box = document.createElement('div');
      box.className = 'mnemo-mem-hit';
      box.style.whiteSpace = 'pre-wrap';
      if (answer === null) box.textContent = ui('askAbove');
      else if (!answer) box.textContent = ui('nothingFound');
      else box.textContent = answer;
      listEl.replaceChildren(box);
    };
    renderAnswer(initialAnswer);

    document
      .getElementById('mnemo-modal-close')
      ?.addEventListener('click', closeModal);
    document
      .getElementById('mnemo-mem-run')
      ?.addEventListener('click', async () => {
        const q = document.getElementById('mnemo-mem-q')?.value?.trim();
        if (!q) return;
        setText(listEl, ui('searching'));
        try {
          renderAnswer(answerText(await sdk.query(q)));
        } catch (err) {
          console.warn('[gods-eye-view] memory query failed:', err);
          if (listEl)
            setText(listEl, `${ui('error')}${err?.message || err}`);
        }
      });
    document
      .getElementById('mnemo-mem-pin')
      ?.addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        setText(btn, `⏳ ${ui('pinning')}`);
        try {
          const viewState = await runGevTool('get_current_view_state', {});
          const entityCtx = await runGevTool('get_entity_context', {});
          // The app writes only into its own sandbox vault; the person decides
          // from the Vault Pad whether it ever joins their real memory.
          const sb = await sdk.ensureSandbox();
          if (!sb?.vault) throw new Error('No sandbox vault returned');
          await sdk.socialIngest(
            sb.vault,
            JSON.stringify({ viewState, entityCtx }, null, 2),
            'SOCIAL_NODE',
          );
          setText(btn, `✅ ${ui('pinned')}`);
        } catch (err) {
          console.warn('[gods-eye-view] pin into memory failed:', err);
          btn.textContent = `⚠️ ${ui('pinFailed')}${err?.message || err}`;
        }
      });
  }

  window.__mnemoShowMemoryResults = (q, hits) => openMemoryModal(q, hits);

  document.getElementById('mnemo-btn-cables')?.addEventListener('click', () => {
    window.__mnemoOpenLicenseModal?.('cables');
  });

  const orbBtn = document.getElementById('mnemo-voice-orb');
  orbBtn?.addEventListener('click', async () => {
    const label = orbBtn.querySelector('.mnemo-bridge-orb-label');
    orbBtn.dataset.state = 'calling';
    try {
      await sdk.invoke('orb.summon', {}, 5000);
      orbBtn.dataset.state = 'idle';
      if (label) label.textContent = orbLabel(assistantName, hostLang);
    } catch (err) {
      // Said on the button, never nothing; each refusal its own sentence.
      console.warn('[gods-eye-view] the orb did not come:', err);
      orbBtn.dataset.state = 'failed';
      if (label) label.textContent = ui('orbFailed');
      orbBtn.title = `${ui(orbFailureKey(err))} (${err?.message || err})`;
    }
  });

  document.getElementById('mnemo-btn-memory')?.addEventListener('click', () => {
    openMemoryModal();
  });

  document.getElementById('mnemo-btn-radar')?.addEventListener(
    'click',
    logged('live pack', async () => {
      for (const lid of [
        'flights',
        'military',
        'satellites',
        'cctv',
        'earthquakes',
      ]) {
        await runGevTool('set_layer_visibility', {
          layerId: lid,
          enabled: true,
        });
      }
      await runGevTool('set_panel_open', { panelId: 'cctv-panel', open: true });
    }),
  );

  document.getElementById('mnemo-btn-cockpit')?.addEventListener(
    'click',
    logged('cockpit', async (ev) => {
      const btn = ev.currentTarget;
      const gev = await waitForGev();
      const cockpitState = gev.styleManager?.getCockpitState?.();
      if (cockpitState?.active) {
        await runGevTool('control_cockpit', { action: 'exit' });
        btn.classList.remove('active');
      } else {
        btn.classList.add('active');
        await runGevTool('control_cockpit', {
          action: 'enter',
          targetLayer: 'flights',
        });
      }
    }),
  );
}

/** Auto-activate sensational feeds on first launch inside Mnemosyne OS. */
async function autoBootSensationalFeeds() {
  try {
    const gev = await waitForGev();
    const bootedKey = 'mnemo.argus.sensationalBoot.v1';
    if (!sessionStorage.getItem(bootedKey)) {
      sessionStorage.setItem(bootedKey, '1');
      for (const lid of [
        'flights',
        'military',
        'satellites',
        'cctv',
        'earthquakes',
      ]) {
        await gev.voiceCommands.runner('set_layer_visibility', {
          layerId: lid,
          enabled: true,
        });
      }
    }
  } catch (err) {
    console.warn('[Argus Mnemosyne Bridge] Auto-boot feeds warning:', err);
  }
}

let activeSub = null;
function ensureAgentDoorSubscribed() {
  try {
    activeSub?.off?.();
  } catch (err) {
    console.warn('[gods-eye-view] agent door unsubscribe failed:', err);
  }
  // The agent door needs a cartridge SDK that has onAgentActions. An older SDK
  // must cost the agent door only, never the globe: this runs before the app
  // starts, and a throw here left the splash screen up forever.
  if (typeof sdk.onAgentActions !== 'function') {
    if (!agentDoorMissingSaid) {
      agentDoorMissingSaid = true;
      console.warn(
        '[gods-eye-view] this cartridge SDK has no onAgentActions: the agent door is off',
      );
    }
    activeSub = null;
    return;
  }
  try {
    activeSub = registerMnemoAgentDoor();
  } catch (err) {
    activeSub = null;
    console.warn('[gods-eye-view] agent door registration failed:', err);
  }
}
let agentDoorMissingSaid = false;

/**
 * Starts the Mnemosyne OS layer. Called by main.js BEFORE the globe app is
 * created, so it never throws: whatever fails here, the globe still starts.
 */
export function initMnemoBridge() {
  try {
    startMnemoBridge();
  } catch (err) {
    console.error(
      '[gods-eye-view] Mnemosyne OS bridge failed to start; the globe runs without it:',
      err,
    );
  }
}

function startMnemoBridge() {
  // Suppress blocking first-run modal so the 3D globe and HUD appear immediately
  try {
    sessionStorage.setItem('gev:first-run-mission-session:v1', '1');
  } catch (err) {
    // Storage blocked: the first-run modal shows, nothing else breaks.
    console.warn('[gods-eye-view] sessionStorage unavailable:', err);
  }
  // Registered ONCE. The host's relay keeps an early subscription; a second
  // one (on load, on each theme or zoom update) dropped the call in flight:
  // « the cartridge window was closed or reloaded » (verifier, 2026-10-20).
  ensureAgentDoorSubscribed();
  window.addEventListener('message', (event) => {
    if (
      event.source !== window.parent ||
      event.data?.type !== 'MNEMO_CONFIG_UPDATE'
    )
      return;
    if (typeof event.data.lang === 'string' && event.data.lang)
      hostLang = event.data.lang;
    if (typeof event.data.assistantName === 'string') {
      assistantName = event.data.assistantName;
      const btn = document.getElementById('mnemo-voice-orb');
      const label = btn?.querySelector('.mnemo-bridge-orb-label');
      // A failed call keeps saying so until the next click.
      if (label && btn.dataset.state !== 'failed')
        label.textContent = orbLabel(assistantName, hostLang);
    }
  });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountMnemoHudOverlay, {
      once: true,
    });
  } else {
    mountMnemoHudOverlay();
  }
  void autoBootSensationalFeeds();
}
