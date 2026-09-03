export type VolumeProgress = {
  targetVolume: number;
  accumulatedVolume: number;
  transactionAmount: number;
};

export type VolumeTargetCompletion = Pick<VolumeProgress, 'targetVolume' | 'accumulatedVolume'> & {
  completedSupplementalRound: boolean;
};

export const isVolumeTargetComplete = ({targetVolume, accumulatedVolume, completedSupplementalRound}: VolumeTargetCompletion): boolean => {
  if (![targetVolume, accumulatedVolume].every(Number.isFinite) || targetVolume <= 0 || accumulatedVolume < 0) {
    throw new Error('交易量参数无效');
  }
  return accumulatedVolume >= targetVolume || completedSupplementalRound;
};

export const nextTransactionAmount = ({targetVolume, accumulatedVolume, transactionAmount}: VolumeProgress): number | null => {
  if (![targetVolume, accumulatedVolume, transactionAmount].every(Number.isFinite)
    || targetVolume <= 0 || accumulatedVolume < 0 || transactionAmount <= 0) {
    throw new Error('交易量参数无效');
  }
  const remainingVolume = Number((targetVolume - accumulatedVolume).toFixed(8));
  if (remainingVolume <= 0) return null;
  const amount = Math.min(transactionAmount, remainingVolume);
  return amount < transactionAmount && amount < 2 ? null : amount;
};
