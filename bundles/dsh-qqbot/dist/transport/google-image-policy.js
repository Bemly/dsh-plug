function eventAt(session, seq) {
  try {
    return session?.eventAt?.(seq);
  } catch {
    return null;
  }
}

function deriveMessage(session, event) {
  try {
    return session?.deriveEventMessage?.(event);
  } catch {
    return null;
  }
}

function pendingImageIndexes(message) {
  const indexes = [];
  let imageIndex = 0;
  const content = Array.isArray(message?.content) ? message.content : [];
  for (const block of content) {
    if (block?.type !== 'image') continue;
    if (block.offloaded !== true) indexes.push(imageIndex);
    imageIndex += 1;
  }
  return indexes;
}

function findImageMessage(session, nodes, minSeq = -1) {
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const seq = nodes[i];
    if (seq <= minSeq) continue;
    const event = eventAt(session, seq);
    if (event?.type !== 'user/message') continue;
    const imageIndexes = pendingImageIndexes(deriveMessage(session, event));
    if (imageIndexes.length > 0) return { seq, imageIndexes };
  }
  return null;
}

export function findGoogleImageOffloadTarget(session) {
  const nodes = Array.from(session?.surface?.nodes ?? []);
  if (nodes.length === 0) return null;
  let stepStartSeq = -1;
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    if (eventAt(session, nodes[i])?.type === 'step/start') {
      stepStartSeq = nodes[i];
      break;
    }
  }
  const current = findImageMessage(session, nodes, stepStartSeq);
  if (current) return current;
  return findImageMessage(session, nodes);
}

export function offloadGooglePolicyImages(session) {
  const target = findGoogleImageOffloadTarget(session);
  if (!target) return null;
  session.append('image/offload', { targets: [target] });
  return target;
}

export function isGoogleInputImagePolicyError(message) {
  const text = String(message ?? '')
    .replace(/\\u0027/gi, "'")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ');
  return /^The model could not generate output because the input image violates Google['’]s Generative AI Prohibited Use policy\.(?: If you think this was an error, send feedback\.)?$/i.test(text);
}
