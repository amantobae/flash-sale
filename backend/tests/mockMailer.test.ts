import { describe, expect, it } from 'vitest';
import { renderEmail } from '../src/modules/emails/mockMailer';

describe('renderEmail', () => {
  it('ORDER_PAID subject and body include the order id and the amount in dollars', () => {
    const message = renderEmail({
      id: 7,
      type: 'ORDER_PAID',
      toEmail: 'alice@example.test',
      payload: { orderId: 42, saleId: 1, amountCents: 4999 },
    });

    expect(message).toMatchObject({ outboxId: 7, type: 'ORDER_PAID', to: 'alice@example.test' });
    expect(message.subject).toContain('#42');
    expect(message.body).toContain('#42');
    expect(message.subject).toContain('$49.99');
    expect(message.body).toContain('$49.99');
  });

  it('SALE_ENDED_CART_CLEARED says the cart was cleared because the sale ended', () => {
    const message = renderEmail({
      id: 3,
      type: 'SALE_ENDED_CART_CLEARED',
      toEmail: 'bob@example.test',
      payload: { saleId: 9 },
    });

    expect(message).toMatchObject({ outboxId: 3, type: 'SALE_ENDED_CART_CLEARED', to: 'bob@example.test' });
    expect(message.subject.toLowerCase()).toContain('cart');
    expect(message.body.toLowerCase()).toContain('your cart was cleared because the sale ended');
  });
});
