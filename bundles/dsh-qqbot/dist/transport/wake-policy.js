export function shouldDrainInboxAfterAbort(
    isAborted,
    pendingInboxCount,
    canFollowup,
) {
    return Boolean(isAborted && (Number(pendingInboxCount) || 0) > 0 && canFollowup);
}
