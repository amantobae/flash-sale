import { prisma } from '../../db';
import { emitDashboardChanged } from '../../realtime/socket';
import { mockMailer, renderEmail } from './mockMailer';

export type DispatchResult = { sent: number; retried: number; failed: number };

function saleIdFromPayload(payload: unknown): number | null {
  if (payload === null || typeof payload !== 'object') return null;
  const saleId = (payload as { saleId?: unknown }).saleId;
  return typeof saleId === 'number' && Number.isInteger(saleId) && saleId > 0 ? saleId : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function dispatchEmails(now: Date): Promise<DispatchResult> {
  const rows = await prisma.emailOutbox.findMany({
    where: { status: 'PENDING' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 20,
  });

  let sentCount = 0;
  let retried = 0;
  let failed = 0;
  const saleIds = new Set<number>();

  for (const row of rows) {
    const claimed = await prisma.$executeRaw`
      UPDATE "EmailOutbox"
      SET status = 'SENDING', attempts = attempts + 1
      WHERE id = ${row.id} AND status = 'PENDING'
    `;
    if (claimed !== 1) continue;

    try {
      await mockMailer.send(renderEmail(row));
      await prisma.emailOutbox.updateMany({
        where: { id: row.id, status: 'SENDING' },
        data: { status: 'SENT', sentAt: now },
      });
      sentCount += 1;
      const saleId = saleIdFromPayload(row.payload);
      if (saleId) saleIds.add(saleId);
    } catch (err) {
      console.error(`Email outbox ${row.id} failed`, err);
      const marked = await prisma.$queryRaw<{ status: string }[]>`
        UPDATE "EmailOutbox"
        SET
          status = CASE WHEN attempts >= 3 THEN 'FAILED'::"EmailStatus" ELSE 'PENDING'::"EmailStatus" END,
          last_error = ${errorMessage(err)}
        WHERE id = ${row.id} AND status = 'SENDING'
        RETURNING status
      `;
      if (marked[0]?.status === 'FAILED') failed += 1;
      else retried += 1;
    }
  }

  for (const saleId of saleIds) emitDashboardChanged({ saleId });
  return { sent: sentCount, retried, failed };
}
