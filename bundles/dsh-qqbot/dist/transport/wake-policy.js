export function shouldWakeInterjectAfterAbort(
    isAborted,
    currentInterjectSeq,
    gateInterjectSeq,
    canFollowup,
) {
    return Boolean(
        isAborted &&
        (Number(currentInterjectSeq) || 0) > (Number(gateInterjectSeq) || 0) &&
        canFollowup,
    );
}
