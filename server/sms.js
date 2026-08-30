// Otaku Sync — OTP delivery.
// Provider is swappable via SMS_PROVIDER so you can start on "console",
// move to MSG91 for Indian numbers, and add Twilio for the rest.

async function sendOtp(phone, code) {
  const provider = (process.env.SMS_PROVIDER || "console").toLowerCase();

  if (provider === "console") {
    console.log(`[OTP] ${phone} -> ${code}`);
    return { ok: true, dev: true };
  }

  if (provider === "msg91") {
    const url = new URL("https://control.msg91.com/api/v5/otp");
    url.searchParams.set("template_id", process.env.MSG91_TEMPLATE_ID || "");
    url.searchParams.set("mobile", phone.replace(/^\+/, ""));
    url.searchParams.set("otp", code);
    if (process.env.MSG91_SENDER) url.searchParams.set("sender", process.env.MSG91_SENDER);
    const res = await fetch(url, {
      method: "POST",
      headers: { authkey: process.env.MSG91_AUTHKEY || "", "Content-Type": "application/json" },
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`msg91 ${res.status}: ${body.slice(0, 200)}`);
    return { ok: true };
  }

  if (provider === "twilio") {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        To: phone,
        From: process.env.TWILIO_FROM || "",
        Body: `${code} is your Otaku Sync code. It expires in 5 minutes.`,
      }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`twilio ${res.status}: ${body.slice(0, 200)}`);
    return { ok: true };
  }

  throw new Error(`unknown SMS_PROVIDER: ${provider}`);
}

module.exports = { sendOtp };
