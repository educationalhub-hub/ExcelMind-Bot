const DEFAULT_ABUSIVE_WORDS = [
  'fuck', 'shit', 'bitch', 'bastard', 'idiot', 'stupid',
  'asshole', 'damn', 'crap', 'moron', 'dick', 'piss',
  'retard', 'bloody', 'wanker', 'fool',
];

export const botState = {
  connection: 'waiting',
  qr: null,
  botNumber: null,
  groups: [],
  logs: [],
  settings: {
    antiLink: true,
    antiAbuse: true,
    abusiveWords: DEFAULT_ABUSIVE_WORDS,
  },
  // Per-group moderation toggles: { [jid]: { moderation: true } }
  // Defaults to enabled for all admin groups.
  groupSettings: {},
  // Muted users: { [`${groupJid}:${senderJid}`]: { muteUntil: ISOString } }
  mutedUsers: {},
};

const MAX_LOGS = 100;

export function addLog(action, details = {}) {
  botState.logs.unshift({
    timestamp: new Date().toISOString(),
    action,
    ...details,
  });
  if (botState.logs.length > MAX_LOGS) {
    botState.logs.length = MAX_LOGS;
  }
}

export function updateGroups(groups) {
  botState.groups = groups;
}

export function updateConnection(status, qr = null) {
  botState.connection = status;
  botState.qr = qr;
}

export function updateSettings(newSettings) {
  if (typeof newSettings.antiLink === 'boolean') {
    botState.settings.antiLink = newSettings.antiLink;
  }
  if (typeof newSettings.antiAbuse === 'boolean') {
    botState.settings.antiAbuse = newSettings.antiAbuse;
  }
  if (Array.isArray(newSettings.abusiveWords)) {
    botState.settings.abusiveWords = newSettings.abusiveWords.filter(
      (w) => typeof w === 'string' && w.trim()
    );
  }
}

export function setBotNumber(number) {
  botState.botNumber = number;
}

export function updateGroupSetting(jid, moderation) {
  if (!botState.groupSettings[jid]) {
    botState.groupSettings[jid] = { moderation: true };
  }
  botState.groupSettings[jid].moderation = moderation;
}

export function getGroupSetting(jid) {
  if (!botState.groupSettings[jid]) {
    return { moderation: true };
  }
  return botState.groupSettings[jid];
}

export function addMutedUser(groupJid, senderJid, durationMs) {
  const key = `${groupJid}:${senderJid}`;
  botState.mutedUsers[key] = {
    muteUntil: new Date(Date.now() + durationMs).toISOString(),
  };
}

export function isUserMuted(groupJid, senderJid) {
  const key = `${groupJid}:${senderJid}`;
  const entry = botState.mutedUsers[key];
  if (!entry) return false;
  if (new Date(entry.muteUntil) <= new Date()) {
    delete botState.mutedUsers[key];
    return false;
  }
  return true;
}

export function removeMutedUser(groupJid, senderJid) {
  delete botState.mutedUsers[`${groupJid}:${senderJid}`];
}
