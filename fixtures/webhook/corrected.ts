const seen = new WeakMap<object, Set<string>>();
export function credit(
  account: { balance: number },
  event: { id: string; amount: number },
) {
  let ids = seen.get(account);
  if (!ids) {
    ids = new Set();
    seen.set(account, ids);
  }
  if (ids.has(event.id)) return;
  account.balance += event.amount;
  ids.add(event.id);
}
