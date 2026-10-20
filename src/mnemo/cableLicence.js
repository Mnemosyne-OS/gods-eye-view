/**
 * The CC BY-NC-SA 3.0 acceptance for TeleGeography's submarine cables, kept
 * by the Mnemosyne OS layer in this window's storage. Browser-only on
 * purpose: the cable source module is also loaded by the MCP server, where
 * there is no window and no storage (check:boundaries refuses it there).
 * The key is the one this layer has always written, so an acceptance made
 * before survives.
 */
export const LICENSE_STORAGE_KEY = 'mnemo.argus.licensePacks.v1';

/** True only when the person accepted; unreadable storage is « not accepted ». */
export function isCableLicenseAccepted() {
  try {
    const raw = localStorage.getItem(LICENSE_STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return Boolean(parsed && parsed.cables);
  } catch (err) {
    console.warn(
      '[gods-eye-view] cable licence unreadable, treated as not accepted:',
      err,
    );
    return false;
  }
}

/** Records the person's choice; a refused write is said, the choice then lasts this session only. */
export function setCableLicenseAccepted(accepted) {
  try {
    const raw = localStorage.getItem(LICENSE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    parsed.cables = Boolean(accepted);
    localStorage.setItem(LICENSE_STORAGE_KEY, JSON.stringify(parsed));
  } catch (err) {
    console.warn('[gods-eye-view] cable licence could not be saved:', err);
  }
}
