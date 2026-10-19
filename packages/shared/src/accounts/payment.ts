import type { TopUp } from "./schemas.ts";

export interface PaymentProvider {
  createCheckout(topup: TopUp): Promise<{ checkoutUrl: string }>;
}

/** Заглушка: `${appUrl}/?checkout=<topupId>`; підтвердження — POST /api/billing/topups/:id/confirm. */
export function createStubPayment(appUrl: string): PaymentProvider {
  const base = appUrl.replace(/\/+$/, "");
  return {
    async createCheckout(topup) {
      return { checkoutUrl: `${base}/?checkout=${encodeURIComponent(topup.id)}` };
    },
  };
}
