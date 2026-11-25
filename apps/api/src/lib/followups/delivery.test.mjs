import assert from "node:assert/strict";
import test from "node:test";
import { parseDeliveryEvents, secretsMatch, shouldApplyDelivery } from "./delivery.ts";

test("outbound reports are read from an object or an array", () => {
  const one = { requestId: "abc", eventName: "Delivered", direction: 1 };
  assert.deepEqual(parseDeliveryEvents(one), [{ requestId: "abc", status: "delivered", reason: null }]);
  assert.equal(parseDeliveryEvents([one, { ...one, requestId: "def", eventName: "read" }]).length, 2);
});

test("inbound, unknown and incomplete events are skipped", () => {
  assert.deepEqual(parseDeliveryEvents({ requestId: "a", eventName: "delivered", direction: 0 }), []);
  assert.deepEqual(parseDeliveryEvents({ requestId: "a", eventName: "template_approved" }), []);
  assert.deepEqual(parseDeliveryEvents({ eventName: "read" }), []);
  assert.deepEqual(parseDeliveryEvents(null), []);
  assert.deepEqual(parseDeliveryEvents("x"), []);
});

test("a failure keeps its reason", () => {
  const [event] = parseDeliveryEvents({ requestId: "a", eventName: "failed", reason: "131049: not delivered" });
  assert.equal(event.reason, "131049: not delivered");
});

test("status only moves forward", () => {
  assert.equal(shouldApplyDelivery(null, "sent"), true);
  assert.equal(shouldApplyDelivery("sent", "delivered"), true);
  assert.equal(shouldApplyDelivery("delivered", "read"), true);
  assert.equal(shouldApplyDelivery("read", "delivered"), false);
  assert.equal(shouldApplyDelivery("delivered", "sent"), false);
  assert.equal(shouldApplyDelivery("delivered", "delivered"), false);
  assert.equal(shouldApplyDelivery("delivered", "failed"), false);
  assert.equal(shouldApplyDelivery("sent", "failed"), true);
  assert.equal(shouldApplyDelivery("failed", "delivered"), true);
  assert.equal(shouldApplyDelivery("failed", "sent"), false);
});

test("the secret is compared exactly", () => {
  assert.equal(secretsMatch("abc", "abc"), true);
  assert.equal(secretsMatch("abd", "abc"), false);
  assert.equal(secretsMatch("ab", "abc"), false);
  assert.equal(secretsMatch(null, "abc"), false);
  assert.equal(secretsMatch("abc", ""), false);
});
