function normalizeVisibleText(text) {
    return String(text ?? '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/\s+/g, ' ');
}
export function isRefusalText(text) {
    const value = normalizeVisibleText(text).toLowerCase();
    // 只匹配明确的拒答表述或结构化错误码。不能拿 policy/guideline 做子串匹配：
    // policyholder、法规讨论、工具日志里的 policies 等正常文本会被误杀并触发会话轮换。
    const explicitRefusal = [
        /\bi(?:'m| am)\s+(?:just\s+)?(?:an?\s+)?(?:ai\s+)?language model\b/,
        /\bwe(?:'re| are)\s+(?:just\s+)?(?:an?\s+)?(?:ai\s+)?language model\b/,
        /\bi(?:'m| am)\s+(?:an?\s+)?(?:ai\s+)?assistant\b[^.!?\n]{0,80}\b(?:can(?:not|'t)|unable to)\b/,
        /\bi\s+(?:can(?:not|'t)|am unable to)\s+(?:help|assist|comply|provide|fulfill|do that)\b/,
        /\b(?:i|we)\s+(?:must|have to|need to)\s+(?:decline|refuse)\b/,
        /\b(?:your|the|this)\s+request\b[^.!?\n]{0,80}\b(?:against|violates?|conflicts? with|go(?:es)? against)\b[^.!?\n]{0,50}\b(?:polic(?:y|ies)|guidelines?|rules?)\b/,
        /\b(?:my|our|the)\s+(?:safety\s+)?(?:polic(?:y|ies)|guidelines?|rules?)\b[^.!?\n]{0,80}\b(?:prevent|prohibit|do not allow|don't allow)\b/,
        /(?:很抱歉|抱歉|对不起)[^。！？\n]{0,50}(?:无法|不能|没法|不便)(?:帮助|协助|回答|提供|满足|执行|完成)/,
        /我(?:无法|不能|没法|不便)(?:帮助|协助|回答|提供|满足|执行|完成)/,
        /(?:请求|要求)[^。！？\n]{0,40}(?:违反|违背|不符合)[^。！？\n]{0,40}(?:政策|准则|规则|安全规定)/,
    ].some((pattern) => pattern.test(value));
    if (explicitRefusal)
        return true;
    // 上游错误对象/日志的明确拒绝结构；单独的 policy/guideline 字段或普通讨论不算。
    return /\b(?:content[_ -]?policy[_ -]?violation|safety[_ -]?violation|moderation[_ -]?(?:blocked|refusal)|refusal[_ -]?(?:blocked|detected))\b/.test(value)
        || /["']?(?:error|code|reason|type)["']?\s*[:=]\s*["']?(?:refusal|content_policy_violation|safety_violation|moderation_blocked)["']?/.test(value);
}
export function isUpstreamAuthError(text) {
    const value = String(text ?? '').trim();
    return /^⚠\s*UNAUTHENTICATED\s*\(code\s+401\):[\s\S]*invalid authentication credentials[\s\S]*OAuth 2 access token/i.test(value);
}
