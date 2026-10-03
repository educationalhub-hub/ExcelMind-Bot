export const config = {
  botDisplayName: 'Bot',
  muteDurationMs: 12 * 60 * 60 * 1000, // 12 hours
  configsPath: './auth_info/bot-configs.json',

  defaultBots: [
    { id: 'bot1', number: '2349164237873', displayName: 'Bot', role: 'Moderator', authDir: './auth_info', active: true, capabilities: { moderation: true, antiLink: true, announcements: false } },
    { id: 'bot2', number: '2347018544908', displayName: null, role: 'Guard', authDir: './auth_info/bot2', active: true, capabilities: { moderation: false, antiLink: true, announcements: false } },
    { id: 'bot3', number: '2349114112326', displayName: null, role: 'Moderator', authDir: './auth_info/bot3', active: true, capabilities: { moderation: true, antiLink: true, announcements: true } },
  ],

  defaultRules: `📋 *GROUP RULES & REGULATIONS*

1️⃣ No posting of links without admin permission
2️⃣ No abusive, offensive, or disrespectful language
3️⃣ No spam, flooding, or irrelevant messages
4️⃣ Respect all group members and admins
5️⃣ No forwarding of fake news or unverified information
6️⃣ Admin decisions are final

⚠️ *Penalty:* Violators will have their message deleted and will be removed from the group for 12 hours.

🔄 The group opens and closes at scheduled times daily.

— *ExcelMind-Bot* 🤖`,

  defaultSchedules: {
    openTime: '08:00',
    closeTime: '22:00',
    morningTime: '07:30',
    morningMessage: '🌅 Good morning everyone! Have a productive day ahead. The group is now open for discussions.',
  },
};
