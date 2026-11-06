import type { AdInsightRow, MetaAdsAdapter } from "./types";
import { CircuitBreaker, httpJson, rupeesToMinor } from "./http";

/** Meta Marketing API insights via a System User token. Graph API version pinned in config. */
export interface MetaCredentials {
  accessToken: string;
  apiVersion: string; // e.g. "v24.0" — verify at deploy time
}

export class MetaGraphAdapter implements MetaAdsAdapter {
  private breaker = new CircuitBreaker();
  constructor(private c: MetaCredentials) {}

  async testConnection() {
    try {
      const r = await httpJson<{ id: string; name?: string }>(`https://graph.facebook.com/${this.c.apiVersion}/me?access_token=${encodeURIComponent(this.c.accessToken)}`);
      return { ok: true as const, message: `Token OK (${r.name ?? r.id})` };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }

  async fetchDailyInsights(adAccountId: string, from: string, to: string): Promise<AdInsightRow[]> {
    const params = new URLSearchParams({
      access_token: this.c.accessToken,
      level: "campaign",
      time_increment: "1",
      time_range: JSON.stringify({ since: from, until: to }),
      fields: "campaign_id,campaign_name,spend,impressions,clicks,actions,action_values,account_currency,date_start",
      limit: "500",
    });
    let url: string | null = `https://graph.facebook.com/${this.c.apiVersion}/act_${adAccountId.replace(/^act_/, "")}/insights?${params}`;
    const out: AdInsightRow[] = [];
    type Row = { campaign_id: string; campaign_name: string; spend: string; impressions: string; clicks: string; date_start: string; account_currency: string; actions?: { action_type: string; value: string }[]; action_values?: { action_type: string; value: string }[] };
    while (url) {
      const page: { data: Row[]; paging?: { next?: string } } = await this.breaker.run(() => httpJson<{ data: Row[]; paging?: { next?: string } }>(url!));
      for (const r of page.data) {
        const purchases = r.actions?.find((a) => a.action_type === "purchase")?.value ?? "0";
        const value = r.action_values?.find((a) => a.action_type === "purchase")?.value ?? "0";
        out.push({ date: r.date_start, campaignId: r.campaign_id, campaignName: r.campaign_name, spendMinor: rupeesToMinor(r.spend), impressions: Number(r.impressions), clicks: Number(r.clicks), purchases: Number(purchases), revenueMinor: rupeesToMinor(value), currency: r.account_currency });
      }
      url = page.paging?.next ?? null;
    }
    return out;
  }
}
