/**
 * The cable licence enforced where the layer turns on, not only on our bar.
 *
 * God's Eye View's own layer panel, its voice assistant, its scenes and the
 * restore of a saved view all turn layers on through LayerLifecycle. Until
 * 2026-11-06 the CC BY-NC-SA 3.0 window covered only the Mnemosyne bar and the
 * agent door, so the panel showed the cables without it. This guard rides
 * upstream's own seam, `addVisibilityGuard`, which every visibility request
 * is checked against before any lifecycle work starts.
 */
export const CABLES_LAYER_ID = 'telegeography-submarine-cables';

/**
 * A visibility guard refusing to turn the cables on until the person accepted.
 * Turning them off is never refused.
 * @param {{ isAccepted: () => boolean, onRefused: (change: object) => void, reason: () => string }} deps
 * @returns {(change: {layerId: string, enabled: boolean}) => (string|null)}
 */
export function createCableLicenceGuard({ isAccepted, onRefused, reason }) {
  return (change) => {
    if (!change || change.layerId !== CABLES_LAYER_ID || !change.enabled)
      return null;
    if (isAccepted()) return null;
    try {
      onRefused(change);
    } catch (err) {
      console.warn('[gods-eye-view] cable licence window could not open:', err);
    }
    return reason();
  };
}

/**
 * Adds the guard to every LayerLifecycle when its registry is sealed, which
 * is before the saved view is restored. Installed once per class.
 * @param {{ prototype: { finalizeRegistrations: Function, addVisibilityGuard?: Function } }} LifecycleClass
 * @param {(change: object) => (string|null)} guard
 * @returns {boolean} false when the class no longer has the seam this needs.
 */
export function installCableLicenceGuard(LifecycleClass, guard) {
  const proto = LifecycleClass?.prototype;
  if (
    typeof proto?.finalizeRegistrations !== 'function' ||
    typeof proto?.addVisibilityGuard !== 'function'
  ) {
    console.error(
      '[gods-eye-view] LayerLifecycle has no finalizeRegistrations/addVisibilityGuard: the cable licence is NOT enforced on the layer panel',
    );
    return false;
  }
  if (proto.__mnemoCableGuardInstalled) return true;
  const finalize = proto.finalizeRegistrations;
  proto.finalizeRegistrations = function finalizeWithCableGuard(...args) {
    this.addVisibilityGuard(guard);
    return finalize.apply(this, args);
  };
  Object.defineProperty(proto, '__mnemoCableGuardInstalled', { value: true });
  return true;
}
