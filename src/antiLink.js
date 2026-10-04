// Comprehensive URL regex — catches http(s)://, www., and bare domain links
// with paths, query strings, ports, and subdomains.
const URL_REGEX =
  /(?:https?:\/\/|www\.)[^\s]+|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?:[/?#][^\s]*)?/gi;

/**
 * Extract all URLs found in `text`.
 * Returns an array of matched URL strings (may contain duplicates).
 */
export function extractLinks(text = '') {
  if (!text) return [];
  URL_REGEX.lastIndex = 0;
  const links = [];
  let match;
  while ((match = URL_REGEX.exec(text)) !== null) {
    links.push(match[0]);
  }
  return links;
}

export function containsLink(text = '') {
  return extractLinks(text).length > 0;
}

export function resetLinkRegex() {
  URL_REGEX.lastIndex = 0;
}

/**
 * Returns true if `url` contains any of the exempted keywords.
 * Exemptions are matched case-insensitively as substrings.
 */
export function isLinkExempted(url, exemptions = []) {
  if (!exemptions.length) return false;
  const lowerUrl = url.toLowerCase();
  return exemptions.some((ex) => {
    const kw = String(ex).toLowerCase().trim();
    return kw && lowerUrl.includes(kw);
  });
}

/**
 * Returns true if `text` contains at least one link that is NOT exempted.
 * Use this for anti-link moderation so that fully-exempted messages are left alone.
 */
export function hasNonExemptedLink(text = '', exemptions = []) {
  const links = extractLinks(text);
  if (!links.length) return false;
  return links.some((link) => !isLinkExempted(link, exemptions));
}

export function isAdmin(participant, groupMetadata) {
  const normalize = (jid) => {
    if (typeof jid !== 'string' || !jid.includes('@')) return null;
    const [user, server] = jid.split('@');
    return `${user.split(':')[0]}@${server === 'c.us' ? 's.whatsapp.net' : server}`;
  };
  const aliases = (Array.isArray(participant) ? participant : [participant])
    .map(normalize).filter(Boolean);
  if (!aliases.length) return false;

  // WhatsApp may address the same person by phone JID or anonymous LID.
  // Check every supplied alias, keeping the two namespaces distinct.
  return (groupMetadata?.participants || []).some((member) =>
    (member.admin === 'admin' || member.admin === 'superadmin') &&
    [member.id, member.jid, member.lid].some((jid) => aliases.includes(normalize(jid))),
  );
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
