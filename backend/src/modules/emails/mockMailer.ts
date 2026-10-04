import type { EmailType } from '@prisma/client';

export type MailMessage = {
  outboxId: number;
  type: EmailType;
  to: string;
  subject: string;
  body: string;
};

export type Renderable = {
  id: number;
  type: EmailType;
  toEmail: string;
  payload: unknown;
};

export const sent: MailMessage[] = [];

export function resetSent(): void {
  sent.length = 0;
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function asRecord(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
}

export function renderEmail(row: Renderable): MailMessage {
  const payload = asRecord(row.payload);
  if (row.type === 'ORDER_PAID') {
    const orderId = payload.orderId;
    const amount = dollars(typeof payload.amountCents === 'number' ? payload.amountCents : 0);
    return {
      outboxId: row.id,
      type: row.type,
      to: row.toEmail,
      subject: `Order #${orderId} paid — ${amount}`,
      body: `Your order #${orderId} was paid. Amount: ${amount}.`,
    };
  }
  return {
    outboxId: row.id,
    type: row.type,
    to: row.toEmail,
    subject: 'Your cart was cleared',
    body: 'Your cart was cleared because the sale ended.',
  };
}

export const mockMailer = {
  async send(message: MailMessage): Promise<void> {
    console.log(`[mailer] to=${message.to} subject=${message.subject}`);
    sent.push(message);
  },
};
