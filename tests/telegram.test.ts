import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateTelegramInitData } from "../src/server/telegram";

function signedInitData(botToken: string, user: Record<string, unknown>, authDate: number): string {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: "query",
    user: JSON.stringify(user),
  });
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  params.set("hash", hash);
  return params.toString();
}

describe("Telegram initData validation", () => {
  it("accepts valid signed initData", () => {
    const botToken = "123456:test";
    const initData = signedInitData(botToken, { id: 1291298838, first_name: "Jacka" }, 1_000);

    expect(validateTelegramInitData(initData, botToken, 60, 1_010)).toMatchObject({
      id: 1291298838,
      first_name: "Jacka",
    });
  });

  it("rejects tampered initData", () => {
    const botToken = "123456:test";
    const initData = signedInitData(botToken, { id: 1, first_name: "Jacka" }, 1_000).replace("Jacka", "Hacker");

    expect(() => validateTelegramInitData(initData, botToken, 60, 1_010)).toThrow("invalid");
  });
});
