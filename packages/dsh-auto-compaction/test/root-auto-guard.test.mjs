import assert from "node:assert/strict";
import { installRootAutoGuard } from "../lib/root-auto-guard.js";

/* A stock-looking provider: the automatic entry point lives on the instance
 * and returns a result unless the guard suppresses the trigger. */
function stockService() {
  return {
    calls: [],
    async compactIfNeeded(agent, trigger, signal) {
      this.calls.push({ agent, trigger, signal });
      return { compacted: true, trigger };
    },
  };
}

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test("suppresses automatic triggers while enabled", async () => {
  const service = stockService();
  const guard = installRootAutoGuard(service, () => true, () => {});
  assert.equal(guard.guarded, true);
  const result = await service.compactIfNeeded(null, "pressure", undefined);
  assert.equal(result, null);
  assert.equal(service.calls.length, 0);
  guard.dispose();
});

test("delegates to the stock engine while the plugin is disabled", async () => {
  const service = stockService();
  const guard = installRootAutoGuard(service, () => false, () => {});
  const result = await service.compactIfNeeded(null, "context-overflow", undefined);
  assert.deepEqual(result, { compacted: true, trigger: "context-overflow" });
  assert.equal(service.calls.length, 1);
  guard.dispose();
});

test("the live switch is re-read on every trigger", async () => {
  let enabled = true;
  const service = stockService();
  const guard = installRootAutoGuard(service, () => enabled, () => {});
  assert.equal(await service.compactIfNeeded(null, "pressure"), null);
  enabled = false;
  assert.deepEqual(await service.compactIfNeeded(null, "pressure"), { compacted: true, trigger: "pressure" });
  assert.equal(service.calls.length, 1);
  guard.dispose();
});

test("skips an engine that is already ours", async () => {
  const service = stockService();
  service.handoff = {};
  const guard = installRootAutoGuard(service, () => true, () => {});
  assert.equal(guard.guarded, false);
  assert.notEqual(await service.compactIfNeeded(null, "pressure"), null);
});

test("installs once; a second activation does not double-wrap", async () => {
  const service = stockService();
  const first = installRootAutoGuard(service, () => true, () => {});
  const second = installRootAutoGuard(service, () => true, () => {});
  assert.equal(first.guarded, true);
  assert.equal(second.guarded, false);
  assert.equal(await service.compactIfNeeded(null, "pressure"), null);
  first.dispose();
  second.dispose();
});

test("dispose restores the original method for a later activation", async () => {
  const service = stockService();
  const original = service.compactIfNeeded;
  const guard = installRootAutoGuard(service, () => true, () => {});
  guard.dispose();
  assert.equal(service.compactIfNeeded, original);
  assert.deepEqual(await service.compactIfNeeded(null, "pressure"), { compacted: true, trigger: "pressure" });
  const again = installRootAutoGuard(service, () => true, () => {});
  assert.equal(again.guarded, true);
  again.dispose();
});

test("a missing provider is a no-op", () => {
  assert.equal(installRootAutoGuard(undefined, () => true).guarded, false);
  assert.equal(installRootAutoGuard({}, () => true).guarded, false);
});

let failed = 0;
for (const { name, fn } of cases) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (error) { failed += 1; console.log(`FAIL ${name}\n     ${error.message}`); }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exitCode = failed === 0 ? 0 : 1;
