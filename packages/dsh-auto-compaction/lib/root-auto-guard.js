/**
 * Root-level automatic-compaction guard.
 *
 * DSH resolves one compaction provider per context. The profile root often has
 * its own stock `compaction-basic` row (user-written or inherited), whose
 * automatic triggers hear every session and compact mid-turn at its own
 * threshold — before this plugin's idle gate ever runs. Replacing preset rows
 * does not silence that instance, so the plugin wraps its automatic entry
 * point and makes it inert while the plugin is enabled; switching the plugin
 * off (or uninstalling) restores it live. Manual `/compact` resolves the
 * preset provider and is unaffected.
 */

const GUARDED = Symbol.for("dsh-auto-compaction.rootAutoGuarded");

/**
 * @param service  the context's compaction provider (root realm)
 * @param isEnabled  read live on every trigger, so the settings switch applies
 *                   without a reload
 * @param log  diagnostic sink
 * @returns {{guarded: boolean, dispose: function}}
 */
export function installRootAutoGuard(service, isEnabled, log = () => {}) {
  if (service === undefined || service === null || typeof service.compactIfNeeded !== "function") {
    return { guarded: false, dispose() {} };
  }
  // Already ours, or already wrapped by an earlier activation.
  if (service.handoff !== undefined || service[GUARDED] === true) {
    return { guarded: false, dispose() {} };
  }
  const original = service.compactIfNeeded;
  const wrapper = async function guardedCompactIfNeeded(agent, trigger, signal) {
    if (isEnabled()) {
      log(`root auto compaction suppressed (${String(trigger)})`);
      return null;
    }
    return original.call(this, agent, trigger, signal);
  };
  service.compactIfNeeded = wrapper;
  Object.defineProperty(service, GUARDED, { value: true, configurable: true });
  return {
    guarded: true,
    dispose() {
      try {
        if (service[GUARDED] === true && service.compactIfNeeded === wrapper) {
          service.compactIfNeeded = original;
          delete service[GUARDED];
        }
      } catch { /* disposal must never block unload */ }
    },
  };
}
