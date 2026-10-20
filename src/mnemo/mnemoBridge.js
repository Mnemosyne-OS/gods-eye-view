import { MnemoCartridgeSDK } from '@mnemosyne_os/cartridge-sdk';
import { voiceLayerAliasMap } from '../voice/layerManifest.js';
import {
  cameraMoved,
  checkedResult,
  compactStatus,
  phrase,
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

/** The person's language, from the host's MNEMO_CONFIG_UPDATE (see phrase in bridgeModel). */
let hostLang = 'en';

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
    throw new Error(
      "God's Eye View is still starting: try again in a few seconds",
    );
  if (gevSettled) return gev;

  const restore = gev.styleManager.initialRestorePromise;
  if (restore && typeof restore.then === 'function') {
    await Promise.race([
      restore.catch(() => undefined),
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

async function runGevTool(actionName, args = {}) {
  const gev = await waitForGev();
  return gev.voiceCommands.runner(actionName, args);
}

/** Normalize city/preset aliases to God's Eye View locationId or search query. */
function normalizeFlyToArgs(params = {}) {
  const rawId = String(params.locationId || params.presetId || '')
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
  const mappedId = ALIAS_MAP[rawId] || rawId;
  if (KNOWN_IDS.has(mappedId)) {
    return {
      locationId: mappedId,
      viewMode: params.viewMode || 'city',
      ...(params.rangeM ? { rangeM: Number(params.rangeM) } : {}),
    };
  }
  if (
    typeof params.latitude === 'number' &&
    typeof params.longitude === 'number'
  ) {
    return {
      latitude: params.latitude,
      longitude: params.longitude,
      viewMode: params.viewMode || 'custom',
      ...(params.rangeM ? { rangeM: Number(params.rangeM) } : {}),
    };
  }
  const query = String(
    params.query || params.locationId || params.presetId || 'New York',
  ).trim();
  return {
    query,
    viewMode: params.viewMode || 'city',
    ...(params.rangeM ? { rangeM: Number(params.rangeM) } : {}),
  };
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
  return sdk.onAgentActions(
    {
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
        // Accept either { layerId, enabled } or { layers: { flights: true, cctv: true } } or { enable: [...], disable: [...] }
        const results = [];
        if (params.layerId) {
          const lid = normalizeLayerId(params.layerId);
          if (
            lid === CABLES_LAYER_ID &&
            params.enabled !== false &&
            !isCableLicenseAccepted()
          ) {
            window.__mnemoOpenLicenseModal?.('cables');
            return {
              ok: false,
              requiresLicenseAcceptance: true,
              packId: 'cables',
              license: 'CC BY-NC-SA 3.0',
              message:
                'TeleGeography Submarine Cables requires user acceptance of the CC BY-NC-SA 3.0 license.',
            };
          }
          const r = await runChecked('set_layer_visibility', {
            layerId: lid,
            enabled: params.enabled !== false,
          });
          results.push(r);
        }
        if (params.layers && typeof params.layers === 'object') {
          for (const [k, v] of Object.entries(params.layers)) {
            const lid = normalizeLayerId(k);
            if (
              lid === CABLES_LAYER_ID &&
              Boolean(v) &&
              !isCableLicenseAccepted()
            ) {
              window.__mnemoOpenLicenseModal?.('cables');
              continue;
            }
            const r = await runChecked('set_layer_visibility', {
              layerId: lid,
              enabled: Boolean(v),
            });
            results.push(r);
          }
        }
        if (Array.isArray(params.enable)) {
          for (const item of params.enable) {
            const lid = normalizeLayerId(item);
            if (lid === CABLES_LAYER_ID && !isCableLicenseAccepted()) {
              window.__mnemoOpenLicenseModal?.('cables');
              continue;
            }
            const r = await runChecked('set_layer_visibility', {
              layerId: lid,
              enabled: true,
            });
            results.push(r);
          }
        }
        if (Array.isArray(params.disable)) {
          for (const item of params.disable) {
            const lid = normalizeLayerId(item);
            const r = await runChecked('set_layer_visibility', {
              layerId: lid,
              enabled: false,
            });
            results.push(r);
          }
        }
        return { ok: true, results };
      },

      setOptics: async (params = {}) => {
        const style = normalizeOpticsStyle(
          params.style || params.mode || 'normal',
        );
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
          ...(params.category ? { category: String(params.category) } : {}),
          ...(params.locationId
            ? { locationId: String(params.locationId) }
            : {}),
          ...(params.country ? { country: String(params.country) } : {}),
          ...(params.stationQuery
            ? { stationQuery: String(params.stationQuery) }
            : {}),
          ...(typeof params.volume === 'number'
            ? { volume: params.volume }
            : {}),
        });
        return { ok: true, action, result: res };
      },

      selectNearestAircraft: async (params = {}) => {
        const where = {
          ...(params.locationId
            ? { locationId: String(params.locationId) }
            : {}),
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

      controlScene: async (params = {}) => {
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
        const q = String(
          params.query || 'geopolitical maritime aviation intelligence',
        ).trim();
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
    },
    { appVersion: '1.0.0' },
  );
}

/** Inject Mnemosyne OS Liquid Glass Bridge UI (License Gate + Vault Memory Seam). */
function mountMnemoHudOverlay() {
  if (document.getElementById('mnemo-argus-bridge')) return;

  const style = document.createElement('style');
  style.textContent = `
    #mnemo-argus-bridge {
      position: fixed;
      bottom: 14px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 9500;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      border-radius: 999px;
      background: linear-gradient(135deg, rgba(10, 16, 28, 0.86) 0%, rgba(6, 10, 18, 0.94) 100%);
      backdrop-filter: blur(18px) saturate(160%);
      border: 1px solid rgba(255, 255, 255, 0.14);
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.55);
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      color: #f1f5f9;
      pointer-events: auto;
    }
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
    .mnemo-bridge-btn {
      appearance: none;
      border: 1px solid rgba(255, 255, 255, 0.14);
      background: rgba(255, 255, 255, 0.05);
      color: #e2e8f0;
      font-size: 11px;
      font-weight: 600;
      padding: 4px 10px;
      border-radius: 999px;
      cursor: pointer;
      transition: all 0.15s ease;
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .mnemo-bridge-btn:hover {
      background: rgba(255, 255, 255, 0.12);
      border-color: rgba(255, 255, 255, 0.28);
    }
    .mnemo-bridge-btn.active {
      background: rgba(16, 185, 129, 0.18);
      border-color: rgba(52, 211, 153, 0.55);
      color: #a7f3d0;
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
  bar.innerHTML = `
    <span class="mnemo-bridge-badge">GOD'S EYE VIEW · MNEMOSYNE OS</span>
    <button type="button" class="mnemo-bridge-btn" id="mnemo-btn-radar" title="Activer Radar ADS-B + Satellites + Webcams CCTV">
      ✈️🎥 Live Pack
    </button>
    <button type="button" class="mnemo-bridge-btn" id="mnemo-btn-cockpit" title="Entrer / Sortir du mode Cockpit 3D à bord d'un avion en vol">
      🛩️ Cockpit 3D
    </button>
    <button type="button" class="mnemo-bridge-btn" id="mnemo-btn-cables" title="Pack Câbles Sous-Marins (Licence CC BY-NC-SA 3.0)">
      📜 Câbles CC BY-NC
    </button>
    <button type="button" class="mnemo-bridge-btn" id="mnemo-btn-memory" title="Interroger ou épingler dans la mémoire Mnemosyne OS">
      🧠 Mémoire
    </button>
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
      btn.textContent = '📜 Câbles CC BY-NC (Actif)';
    } else {
      btn.classList.remove('active');
      btn.textContent = '📜 Câbles CC BY-NC';
    }
  }
  window.__mnemoSyncLicenseUi = syncLicenseUi;
  syncLicenseUi();

  window.__mnemoOpenLicenseModal = () => {
    const accepted = isCableLicenseAccepted();
    backdrop.innerHTML = `
      <div class="mnemo-modal-card">
        <h3>📜 Pack Données Externes — Licence Utilisateur</h3>
        <p>
          Le cœur de <strong>God's Eye View</strong> (par Bilawal Sidhu) est distribué sous licence <strong>MIT</strong>.
          Les tracés mondiaux de câbles sous-marins sont publiés par <strong>TeleGeography</strong> sous licence
          <strong>Creative Commons CC BY-NC-SA 3.0 (Usage Non-Commercial)</strong>.
          Mnemosyne OS ne vend ni n'embarque ces fichiers dans le dépôt : vous pouvez les charger directement à la demande pour votre usage personnel.
        </p>
        <div class="mnemo-license-box">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <strong style="font-size:13px;color:#fff;">TeleGeography Submarine Cable Map (712 câbles & stations)</strong>
            <span class="mnemo-bridge-badge">CC BY-NC-SA 3.0</span>
          </div>
          <p style="margin:0;font-size:11.5px;">
            Source : TeleGeography (submarinecablemap.com). En activant ce pack, vous acceptez les termes CC BY-NC-SA 3.0 pour votre consultation personnelle dans Mnemosyne OS.
          </p>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:10px;">
          <button type="button" class="mnemo-action-secondary" id="mnemo-modal-close">Fermer</button>
          ${
            accepted
              ? '<button type="button" class="mnemo-action-secondary" id="mnemo-license-revoke">Désactiver le pack</button>'
              : '<button type="button" class="mnemo-action-primary" id="mnemo-license-accept">J\'accepte la licence CC BY-NC-SA 3.0 · Charger les câbles</button>'
          }
        </div>
      </div>
    `;
    backdrop.classList.add('open');
    document
      .getElementById('mnemo-modal-close')
      ?.addEventListener('click', closeModal);
    document
      .getElementById('mnemo-license-accept')
      ?.addEventListener('click', async () => {
        setCableLicenseAccepted(true);
        syncLicenseUi();
        closeModal();
        await runGevTool('set_layer_visibility', {
          layerId: CABLES_LAYER_ID,
          enabled: true,
        });
      });
    document
      .getElementById('mnemo-license-revoke')
      ?.addEventListener('click', async () => {
        setCableLicenseAccepted(false);
        syncLicenseUi();
        closeModal();
        await runGevTool('set_layer_visibility', {
          layerId: CABLES_LAYER_ID,
          enabled: false,
        });
      });
  };

  function openMemoryModal(initialQuery = '', initialAnswer = null) {
    backdrop.innerHTML = `
      <div class="mnemo-modal-card">
        <h3>🧠 Pont Mémoire Mnemosyne OS</h3>
        <p>Interrogez votre mémoire Mnemosyne OS ou épinglez la vue actuelle.</p>
        <div style="display:flex;gap:8px;">
          <input type="text" class="mnemo-mem-input" id="mnemo-mem-q" placeholder="Rechercher dans vos notes (ex: aviation, câble, satellite, port...)" value="${initialQuery.replace(/"/g, '&quot;')}" style="margin-bottom:0;flex:1;" />
          <button type="button" class="mnemo-action-primary" id="mnemo-mem-run">Chercher</button>
        </div>
        <div class="mnemo-mem-results" id="mnemo-mem-list"></div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:14px;">
          <button type="button" class="mnemo-action-secondary" id="mnemo-mem-pin">📌 Épingler la vue actuelle dans Mnemosyne</button>
          <button type="button" class="mnemo-action-secondary" id="mnemo-modal-close">Fermer</button>
        </div>
      </div>
    `;
    backdrop.classList.add('open');
    const listEl = document.getElementById('mnemo-mem-list');
    // `null` = nothing asked yet; '' = asked, and memory had nothing to say.
    const renderAnswer = (answer) => {
      if (!listEl) return;
      const box = document.createElement('div');
      box.className = 'mnemo-mem-hit';
      box.style.whiteSpace = 'pre-wrap';
      if (answer === null) box.textContent = 'Posez une question ci-dessus.';
      else if (!answer)
        box.textContent = 'Votre mémoire ne contient rien sur ce sujet.';
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
        listEl.innerHTML = `<div class="mnemo-mem-hit">Recherche dans Mnemosyne OS...</div>`;
        try {
          renderAnswer(answerText(await sdk.query(q)));
        } catch (err) {
          console.warn('[gods-eye-view] memory query failed:', err);
          if (listEl) listEl.textContent = `Erreur : ${err?.message || err}`;
        }
      });
    document
      .getElementById('mnemo-mem-pin')
      ?.addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        btn.textContent = '⏳ Épinglage...';
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
          btn.textContent = '✅ Épinglé dans Mnemosyne !';
        } catch (err) {
          console.warn('[gods-eye-view] pin into memory failed:', err);
          btn.textContent = `⚠️ Épinglage impossible : ${err?.message || err}`;
        }
      });
  }

  window.__mnemoShowMemoryResults = (q, hits) => openMemoryModal(q, hits);

  document.getElementById('mnemo-btn-cables')?.addEventListener('click', () => {
    window.__mnemoOpenLicenseModal?.('cables');
  });

  document.getElementById('mnemo-btn-memory')?.addEventListener('click', () => {
    openMemoryModal();
  });

  document
    .getElementById('mnemo-btn-radar')
    ?.addEventListener('click', async () => {
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
    });

  document
    .getElementById('mnemo-btn-cockpit')
    ?.addEventListener('click', async (ev) => {
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
    });
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
  ensureAgentDoorSubscribed();
  window.addEventListener('load', () => {
    setTimeout(ensureAgentDoorSubscribed, 120);
  });
  window.addEventListener('message', (event) => {
    if (
      event.source !== window.parent ||
      event.data?.type !== 'MNEMO_CONFIG_UPDATE'
    )
      return;
    if (typeof event.data.lang === 'string' && event.data.lang)
      hostLang = event.data.lang;
    if (event.data.tokens) setTimeout(ensureAgentDoorSubscribed, 60);
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
