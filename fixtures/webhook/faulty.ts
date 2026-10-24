export function credit(
  account: { balance: number },
  event: { id: string; amount: number },
) {
  account.balance += event.amount;
}
