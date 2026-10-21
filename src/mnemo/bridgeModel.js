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
/** A bridge sentence in the host's language; an unknown language falls back to English. */
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
    // Not `say`: the orb reads a `say` aloud word for word, and this one is
    // God's Eye View's English sentence. The planner words it for the person.
    summary: viewState?.say ?? null,
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

/**
 * The bridge's own screen text (HUD bar, licence window, memory window) in
 * the three languages the host ships first. God's Eye View has no French:
 * an English or Spanish speaker saw these in French before (2026-10-20).
 */
export const UI_TEXT = {
  radarTitle: {
    en: 'Turn on live aircraft, satellites and webcams',
    fr: 'Allumer les avions en direct, les satellites et les webcams',
    es: 'Encender los aviones en directo, los satélites y las webcams',
  },
  cockpitTitle: {
    en: 'Enter or leave the 3D cockpit of a live aircraft',
    fr: 'Entrer dans le cockpit 3D d’un avion en vol, ou en sortir',
    es: 'Entrar en la cabina 3D de un avión en vuelo, o salir',
  },
  cockpit: { en: 'Cockpit 3D', fr: 'Cockpit 3D', es: 'Cabina 3D' },
  cablesTitle: {
    en: 'Submarine cables (licence CC BY-NC-SA 3.0)',
    fr: 'Câbles sous-marins (licence CC BY-NC-SA 3.0)',
    es: 'Cables submarinos (licencia CC BY-NC-SA 3.0)',
  },
  cables: {
    en: 'Cables CC BY-NC',
    fr: 'Câbles CC BY-NC',
    es: 'Cables CC BY-NC',
  },
  cablesOn: {
    en: 'Cables CC BY-NC (on)',
    fr: 'Câbles CC BY-NC (actifs)',
    es: 'Cables CC BY-NC (activos)',
  },
  memoryTitle: {
    en: 'Ask your Mnemosyne OS memory, or pin this view into it',
    fr: 'Interroger ta mémoire Mnemosyne OS, ou y épingler cette vue',
    es: 'Preguntar a tu memoria de Mnemosyne OS, o fijar esta vista en ella',
  },
  memory: { en: 'Memory', fr: 'Mémoire', es: 'Memoria' },
  orb: {
    en: 'Voice: talk to the orb',
    fr: "Voix : parle à l'orbe",
    es: 'Voz: habla con el orbe',
  },
  orbTitle: {
    en: "Inside Mnemosyne OS, the orb listens and drives the globe: say « fly to Tokyo » or « show live planes ». God's Eye View's own voice agent is off here, because the microphone stays with Mnemosyne OS.",
    fr: "Dans Mnemosyne OS, c'est l'orbe qui écoute et pilote le globe : dis « vole vers Tokyo » ou « montre les avions en direct ». L'agent vocal de God's Eye View est coupé ici, parce que le micro reste à Mnemosyne OS.",
    es: "En Mnemosyne OS, el orbe escucha y maneja el globo: di « vuela a Tokio » o « muestra los aviones en directo ». El agente de voz de God's Eye View está apagado aquí, porque el micrófono se queda en Mnemosyne OS.",
  },
  licenceHeading: {
    en: 'Submarine cables: the licence',
    fr: 'Câbles sous-marins : la licence',
    es: 'Cables submarinos: la licencia',
  },
  licenceBody: {
    en: "God's Eye View by Bilawal Sidhu is MIT. The submarine cable map comes from TeleGeography under CC BY-NC-SA 3.0, for non-commercial use. The cables appear only after you accept that licence.",
    fr: "God's Eye View, de Bilawal Sidhu, est sous licence MIT. La carte des câbles sous-marins vient de TeleGeography, sous licence CC BY-NC-SA 3.0, pour un usage non commercial. Les câbles ne s'affichent qu'après ton accord.",
    es: "God's Eye View, de Bilawal Sidhu, tiene licencia MIT. El mapa de cables submarinos viene de TeleGeography, con licencia CC BY-NC-SA 3.0, para uso no comercial. Los cables solo aparecen después de que aceptes esa licencia.",
  },
  licenceSource: {
    en: 'Source: TeleGeography (submarinecablemap.com).',
    fr: 'Source : TeleGeography (submarinecablemap.com).',
    es: 'Fuente: TeleGeography (submarinecablemap.com).',
  },
  close: { en: 'Close', fr: 'Fermer', es: 'Cerrar' },
  revoke: {
    en: 'Turn the cables off',
    fr: 'Désactiver les câbles',
    es: 'Desactivar los cables',
  },
  accept: {
    en: 'I accept CC BY-NC-SA 3.0 · Show the cables',
    fr: 'J’accepte CC BY-NC-SA 3.0 · Afficher les câbles',
    es: 'Acepto CC BY-NC-SA 3.0 · Mostrar los cables',
  },
  memoryHeading: {
    en: 'Your Mnemosyne OS memory',
    fr: 'Ta mémoire Mnemosyne OS',
    es: 'Tu memoria de Mnemosyne OS',
  },
  memoryIntro: {
    en: 'Ask your memory a question, or pin the current view into it.',
    fr: 'Pose une question à ta mémoire, ou épingle-y la vue actuelle.',
    es: 'Haz una pregunta a tu memoria, o fija en ella la vista actual.',
  },
  memoryPlaceholder: {
    en: 'Search your notes (aviation, cable, satellite, port…)',
    fr: 'Chercher dans tes notes (aviation, câble, satellite, port…)',
    es: 'Buscar en tus notas (aviación, cable, satélite, puerto…)',
  },
  search: { en: 'Search', fr: 'Chercher', es: 'Buscar' },
  pin: {
    en: 'Pin this view into Mnemosyne OS',
    fr: 'Épingler cette vue dans Mnemosyne OS',
    es: 'Fijar esta vista en Mnemosyne OS',
  },
  askAbove: {
    en: 'Ask a question above.',
    fr: 'Pose une question ci-dessus.',
    es: 'Haz una pregunta arriba.',
  },
  nothingFound: {
    en: 'Your memory holds nothing on this.',
    fr: 'Ta mémoire ne contient rien sur ce sujet.',
    es: 'Tu memoria no tiene nada sobre esto.',
  },
  searching: {
    en: 'Searching Mnemosyne OS…',
    fr: 'Recherche dans Mnemosyne OS…',
    es: 'Buscando en Mnemosyne OS…',
  },
  error: { en: 'Error: ', fr: 'Erreur : ', es: 'Error: ' },
  pinning: { en: 'Pinning…', fr: 'Épinglage…', es: 'Fijando…' },
  pinned: {
    en: 'Pinned into Mnemosyne OS',
    fr: 'Épinglé dans Mnemosyne OS',
    es: 'Fijado en Mnemosyne OS',
  },
  pinFailed: {
    en: 'Could not pin: ',
    fr: 'Épinglage impossible : ',
    es: 'No se pudo fijar: ',
  },
};

/** Screen text in en, fr or es; any other language falls back to English. */
export function uiText(key, lang = 'en') {
  const row = UI_TEXT[key];
  const code = String(lang || 'en')
    .toLowerCase()
    .slice(0, 2);
  return row?.[code] || row?.en || key;
}

/**
 * Whether this page runs inside a host frame (a Mnemosyne OS window) rather
 * than in a browser tab of its own. A window that cannot read its parent is
 * still framed: only `parent === self` means « on its own ».
 */
export function isFramedByHost(win) {
  if (!win) return false;
  try {
    return win.parent != null && win.parent !== win;
  } catch (err) {
    console.warn('[gods-eye-view] could not read window.parent:', err);
    return true;
  }
}
