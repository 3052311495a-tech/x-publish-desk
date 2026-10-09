/** A sent request without a verified result must never be offered as a retry. */
export function deliveryReceiptUncertain(result: Record<string, unknown>): boolean {
  return result.uncertain === true || result.state === 'uncertain' || result.status === 'uncertain'
    || (result.verified !== true && (result.mutation_started === true || result.commit_sent === true || result.retry_allowed === false))
    || (typeof result.error === 'string'
      && /上次提交.*待核对|已停止重发|已有发布或定时记录|已按另一个时间定时|发布记录尚未核验|这一版已有提交记录/.test(result.error));
}
