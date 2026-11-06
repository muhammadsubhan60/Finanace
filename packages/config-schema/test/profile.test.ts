import { describe, expect, it } from "vitest";
import { AgreementProfile, SEED_PROFILE } from "../src";

describe("Agreement Profile schema", () => {
  it("accepts the Draft 3 seed", () => expect(AgreementProfile.parse(SEED_PROFILE).version).toBe(1));
  it("rejects shares not totalling 100%", () => {
    expect(() => AgreementProfile.parse({ ...SEED_PROFILE, partners: SEED_PROFILE.partners.map((p) => ({ ...p, sharePct: 40 })) })).toThrow(/total 100/);
  });
  it("rejects a capital provider who is not a partner", () => {
    expect(() => AgreementProfile.parse({ ...SEED_PROFILE, capital: { ...SEED_PROFILE.capital, providerPartnerId: "nobody" } })).toThrow(/Capital provider/);
  });
  it("rejects unknown normalized statuses in mappings", () => {
    expect(() => AgreementProfile.parse({ ...SEED_PROFILE, statusMappings: { leopards: { x: "teleported" } } })).toThrow();
  });
});
