import type { PaymentStatus } from '@prisma/client';

export type MockOutcome = 'SUCCESS' | 'FAILED' | 'PENDING';

export type ProviderResult = {
  status: PaymentStatus;
};

const STATUS_BY_OUTCOME: Record<MockOutcome, PaymentStatus> = {
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  PENDING: 'PENDING',
};

export function charge(outcome: MockOutcome): ProviderResult {
  return { status: STATUS_BY_OUTCOME[outcome] };
}
