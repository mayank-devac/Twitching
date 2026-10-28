import test from "node:test";
import assert from "node:assert/strict";
import { credentialGuard } from "../server/redact.js";

test("ordinary secret/password variables and placeholder text are allowed unchanged", () => {
  const html = `<html><body><script>const secret = 'blue'; const password = 'rainbow'; const authorization = 'demo';</script><input type="password" value="example"></body></html>`;
  const guard = credentialGuard(["private-test-credential-value"]);
  assert.doesNotThrow(() => guard(html));
  assert.equal(guard(html), undefined);
});

test("actual known credentials are refused without including them in errors", () => {
  const secret = "private-test-credential-value";
  const html = `<html><body>${secret}</body></html>`;
  assert.throws(
    () => credentialGuard([secret])(html),
    (error: unknown) =>
      error instanceof Error &&
      /contains credentials/.test(error.message) &&
      !error.message.includes(secret),
  );
});

test("credential-shaped tokens are refused even without a known secret", () => {
  const guard = credentialGuard(["", "ab"]);
  for (const token of [
    "sk-" + "A".repeat(32),
    "ghp_" + "B".repeat(32),
    "jv_live_" + "C".repeat(32),
    "eyJ" + "D".repeat(12) + "." + "E".repeat(16) + "." + "F".repeat(16),
    "Bearer " + "G".repeat(32),
  ])
    assert.throws(
      () => guard(`<html><body>${token}</body></html>`),
      /contains credentials/,
    );
  assert.doesNotThrow(() => guard("<html><body>Bearer example</body></html>"));
});
