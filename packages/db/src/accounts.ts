import type { AgreementProfile } from "@delta/config-schema";
import { capitalAccount, expenseAccount, partnerDrawingsAccount, partnerProfitAccount, reinvestmentClaimAccount, type AccountType } from "@delta/core";

/** Seed chart of accounts, derived from the profile (partners, categories). Editable afterwards. */
export function seedAccounts(profile: AgreementProfile): { _id: string; name: string; type: AccountType; system?: boolean }[] {
  const a = (id: string, name: string, type: AccountType) => ({ _id: id, name, type });
  return [
    a("bank", "Bank", "asset"),
    a("cash", "Cash", "asset"),
    a("courier_cod_in_transit", "Courier COD in transit", "asset"),
    a("courier_cod_receivable_settled_pending", "Courier COD settled, pending receipt", "asset"),
    a("inventory", "Inventory", "asset"),
    a("reinvestment_claims_contra", "Reinvestment claims (contra)", "asset"),
    a("accounts_payable", "Accounts payable", "liability"),
    a("card_payable", "Card payable (ad spend)", "liability"),
    a("accrued_liabilities", "Accrued liabilities", "liability"),
    a("taxes_payable", "Taxes payable", "liability"),
    a("suspense", "Suspense (bank reconciliation)", "liability"),
    ...profile.partners.filter((p) => p.isCapitalProvider).map((p) => a(capitalAccount(p.partnerId), `Capital — ${p.label}`, "equity")),
    a("reinvestment_fund", "Reinvestment fund", "equity"),
    a("retained_earnings", "Retained earnings / current result", "equity"),
    ...profile.partners.flatMap((p) => [
      a(partnerProfitAccount(p.partnerId), `Undrawn profit — ${p.label}`, "equity"),
      a(partnerDrawingsAccount(p.partnerId), `Drawings — ${p.label}`, "equity"),
      a(reinvestmentClaimAccount(p.partnerId), `Reinvestment claim — ${p.label}`, "equity"),
      a(`netting_receivable_${p.partnerId}`, `Netting receivable — ${p.label}`, "asset"),
    ]),
    a("sales", "Sales", "income"),
    a("sales_returns_discounts", "Sales returns & discounts", "income"),
    a("sales_refunds", "Refunds", "income"),
    a("sales_tax_collected", "Taxes collected on sales", "income"),
    ...profile.expenseCategories.map((c) => a(expenseAccount(c.key), c.label, "expense")),
    a(expenseAccount("inventory_writedown"), "Inventory write-down", "expense"),
    a("loss_carry_forward", "Loss carry-forward (memo)", "memo"),
  ];
}
