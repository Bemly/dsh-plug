export function isUpstreamAuthError(text) {
    const value = String(text ?? '').trim();
    return /^⚠\s*UNAUTHENTICATED\s*\(code\s+401\):[\s\S]*invalid authentication credentials[\s\S]*OAuth 2 access token/i.test(value);
}
