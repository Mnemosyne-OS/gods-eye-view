/**
 * The pure half of the Mnemosyne OS bridge: no SDK, no DOM, so it is tested
 * with node:test like the rest of God's Eye View (bridgeModel.test.mjs).
 */

/**
 * The sentences the bridge says itself, in the host's 7 languages. A `say` it
 * returns is spoken AS IS by the orb, in place of the sentence the
 * orb wrote in the person's language: an English line here was read out in
 * English to a French speaker (2026-10-19).
 */
export const PHRASES = {
  notOnScreen: {
    en: 'The window is not on screen: the camera will fly when it is shown.',
    fr: 'La fenêtre n’est pas affichée : la caméra partira quand elle le sera.',
    es: 'La ventana no está en pantalla: la cámara volará cuando se muestre.',
    de: 'Das Fenster ist nicht sichtbar: Die Kamera fliegt los, sobald es angezeigt wird.',
    pt: 'A janela não está visível: a câmara vai voar quando for mostrada.',
    ru: 'Окно не на экране: камера полетит, когда его покажут.',
    zh: '窗口未显示：显示后镜头才会飞过去。',
  },
  licenceWindow: {
    en: 'The licence window is open: accept it there to show the cables.',
    fr: 'La fenêtre de licence est ouverte : accepte-la pour afficher les câbles.',
    es: 'La ventana de licencia está abierta: acéptala para mostrar los cables.',
    de: 'Das Lizenzfenster ist offen: Bestätige es dort, um die Kabel zu zeigen.',
    pt: 'A janela da licença está aberta: aceita-a para mostrar os cabos.',
    ru: 'Окно лицензии открыто: примите её, чтобы показать кабели.',
    zh: '许可窗口已打开：在那里接受后即可显示海缆。',
  },
};
export function phrase(key, lang = 'en') {
  const table = PHRASES[key];
  const code = String(lang || 'en')
    .toLowerCase()
    .slice(0, 2);
  return table?.[code] || table?.en || '';
}

/**
 * God's Eye View answers a failure as a value (`{ ok: false, error, say }`).
 * Wrapping that in `{ ok: true }` told the agent, and the orb after it, that
 * a refused action had been done: the agent door throws it instead.
 */
export function checkedResult(res, actionName) {
  if (res && typeof res === 'object' && res.ok === false) {
    throw new Error(String(res.error || res.say || `${actionName} failed`));
  }
  return res;
}

/** More than a metre between two readings; unknown readings never count as moved. */
export function cameraMoved(a, b) {
  return Boolean(a && b) && Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) > 1;
}

/** What a person asks about the view, in ~1 KB instead of ~19 KB. */
export function compactStatus(viewState, entityCtx, licensePacks, fps = null) {
  const layers = Array.isArray(viewState?.layers) ? viewState.layers : [];
  return {
    app: "God's Eye View",
    say: viewState?.say ?? null,
    framesPerSecond: fps,
    onScreen: fps === null ? null : fps > 0,
    camera: viewState?.camera ?? null,
    style: viewState?.style ?? null,
    contextMode: viewState?.context?.mode ?? null,
    cockpitActive: viewState?.cockpit?.active ?? null,
    tracked: viewState?.tracked ?? [],
    scenePlaying: viewState?.scenePlayback?.running ?? null,
    layersOn: layers
      .filter((l) => l.enabled)
      .map((l) => ({
        id: l.id,
        count: l.count ?? null,
        feedState: l.feedState ?? null,
        ...(l.error ? { error: l.error } : {}),
      })),
    layersOff: layers.filter((l) => !l.enabled).map((l) => l.id),
    entitiesInView: entityCtx?.count ?? null,
    selected: entityCtx?.selected ?? null,
    licensePacks,
    more: 'status {"full": true} gives the whole state (~19 KB).',
  };
}
