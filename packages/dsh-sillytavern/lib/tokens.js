/**
 * Token accounting for prompt budgeting.
 *
 * DSH's token meter measures real messages against the active tokenizer, but a
 * world-info budget has to be spent before the messages exist, and the
 * libraries are model-agnostic. This estimator is therefore deliberately
 * conservative: CJK characters count as one token each, everything else at a
 * quarter token per character with a floor for short strings.
 */

const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/

export function estimateTokens(text) {
  if (!text) return 0
  let cjk = 0
  for (const char of text) {
    if (CJK.test(char)) cjk++
  }
  const rest = text.length - cjk
  return cjk + Math.ceil(rest / 4)
}

export function estimateEntryTokens(entry) {
  return estimateTokens(entry?.content ?? '')
}
