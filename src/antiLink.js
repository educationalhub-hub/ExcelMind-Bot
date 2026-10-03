const URL_REGEX =
  /(https?:\/\/|www\.)[^\s]+|(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+\.[a-z]{2,}(?:\/[^\s]*)?/gi;

export function containsLink(text = '') {
  return URL_REGEX.test(text);
}

export function resetLinkRegex() {
  URL_REGEX.lastIndex = 0;
}

export function isAdmin(participant, groupMetadata) {
  if (!participant || !groupMetadata) return false;

  const participantJid = participant.split(':')[0];

  const member = groupMetadata.participants.find((p) => {
    const jid = p.id?.split(':')[0];
    return jid === participantJid;
  });

  if (!member) return false;

  return member.admin === 'admin' || member.admin === 'superadmin';
}

export function containsAbuse(text = '', words = []) {
  if (!text || !words.length) return false;
  return words.some((word) => {
    const escaped = word
      .toLowerCase()
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
  });
}
