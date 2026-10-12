/**
 * Transactional email: password resets and invitations.
 *
 *   RESEND_API_KEY      enables sending through Resend (free tier: 3,000/month)
 *   QYNTRA_EMAIL_FROM   e.g. "Qyntra <no-reply@yourdomain.com>", a verified sender
 *
 * Without them, development prints the message to the server log, and
 * production says email is not configured — never a silent drop.
 */

export interface Email {
  to: string;
  subject: string;
  text: string;
}

export const emailConfigured = () => !!process.env.RESEND_API_KEY && !!process.env.QYNTRA_EMAIL_FROM;

/** True when the message was handed to a provider (or logged in development). */
export async function sendEmail(email: Email, production: boolean): Promise<boolean> {
  if (!emailConfigured()) {
    if (production) return false;
    console.log(`[email, development] to ${email.to}: ${email.subject}\n${email.text}`);
    return true;
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: process.env.QYNTRA_EMAIL_FROM, to: [email.to], subject: email.subject, text: email.text }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) console.error('email refused', response.status, (await response.text()).slice(0, 300));
    return response.ok;
  } catch (error) {
    console.error('email failed', String(error));
    return false;
  }
}
