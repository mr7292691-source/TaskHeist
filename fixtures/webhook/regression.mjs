import assert from "node:assert/strict";
import { credit } from "/workspace/webhook.ts";
const a = { balance: 0 },
  b = { balance: 0 };
credit(a, { id: "one", amount: 10 });
credit(a, { id: "one", amount: 10 });
assert.equal(a.balance, 10, "duplicate event credited twice");
credit(a, { id: "two", amount: 5 });
assert.equal(a.balance, 15);
credit(b, { id: "one", amount: 10 });
assert.equal(b.balance, 10);
console.log("PASS duplicate, distinct event, and account isolation");
