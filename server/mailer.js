// Otaku Sync — email delivery for verification codes.
// Provider is swappable via MAIL_PROVIDER: console | resend | brevo.
// Email OTP costs effectively nothing anywhere in the world, which makes it
// the sensible default for users outside India.

const FROM_NAME = "Otaku Sync";
let transport = null; // lazily created SMTP transport, reused between sends

async function sendMail(to, subject, text) {
  const provider = (process.env.MAIL_PROVIDER || "console").toLowerCase();
  const from = process.env.MAIL_FROM || "no-reply@yogeshmallidi.com";

  if (provider === "console") {
    console.log(`[MAIL] to=${to} subject=${subject}\n${text}`);
    return { ok: true, dev: true };
  }

  if (provider === "resend") {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY || ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: `${FROM_NAME} <${from}>`, to: [to], subject, text }),
    });
    if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return { ok: true };
  }

  if (provider === "brevo") {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": process.env.BREVO_API_KEY || "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sender: { name: FROM_NAME, email: from },
        to: [{ email: to }],
        subject,
        textContent: text,
      }),
    });
    if (!res.ok) throw new Error(`brevo ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return { ok: true };
  }

  if (provider === "smtp") {
    // Works with Gmail (needs 2FA + an App Password) or any SMTP host.
    // Note: with Gmail the From address must be your Gmail account or a
    // verified alias — a made-up no-reply@ address will be rewritten.
    const nodemailer = require("nodemailer");
    if (!transport) {
      transport = nodemailer.createTransport({
        host: process.env.SMTP_HOST || "smtp.gmail.com",
        port: parseInt(process.env.SMTP_PORT || "465", 10),
        secure: String(process.env.SMTP_SECURE || "true") === "true",
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
    }
    await transport.sendMail({ from: `${FROM_NAME} <${from}>`, to, subject, text });
    return { ok: true };
  }

  throw new Error(`unknown MAIL_PROVIDER: ${provider}`);
}

const sendCode = (to, code) =>
  sendMail(
    to,
    `${code} is your Otaku Sync code`,
    `Your Otaku Sync verification code is ${code}.\n\nIt expires in 10 minutes. If you didn't ask for this, ignore this email.`
  );

module.exports = { sendMail, sendCode };
