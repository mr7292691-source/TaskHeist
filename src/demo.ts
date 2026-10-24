import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git } from "./process.js";
export const faulty = `export function credit(account: { balance: number }, event: { id: string; amount: number }) { account.balance += event.amount; }\n`;
export const corrected = `const seen = new WeakMap<object, Set<string>>();
export function credit(account: { balance: number }, event: { id: string; amount: number }) {
  let ids = seen.get(account);
  if (!ids) { ids = new Set(); seen.set(account, ids); }
  if (ids.has(event.id)) return;
  account.balance += event.amount;
  ids.add(event.id);
}\n`;
export const regression = `import assert from 'node:assert/strict';
import { credit } from '/workspace/webhook.ts';
const a = {balance: 0}, b = {balance: 0};
credit(a, {id:'one',amount:10}); credit(a, {id:'one',amount:10});
assert.equal(a.balance,10,'duplicate event credited twice');
credit(a, {id:'two',amount:5}); assert.equal(a.balance,15);
credit(b, {id:'one',amount:10}); assert.equal(b.balance,10);
console.log('PASS duplicate, distinct event, and account isolation');\n`;
export const demoCheck = {
  id: "idempotency",
  criterionIds: ["AC1"],
  command: ["node", "--experimental-strip-types", "/verifier/test.mjs"],
  test: regression,
};
export async function createDemo(path: string) {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "webhook.ts"), faulty);
  await git(["init", path]);
  await git(["add", "."], path);
  await git(
    [
      "-c",
      "user.name=TaskHeist",
      "-c",
      "user.email=demo@taskheist.local",
      "commit",
      "-m",
      "Faulty webhook fixture",
    ],
    path,
  );
  return path;
}
