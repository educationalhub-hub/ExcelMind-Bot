export const config = {
  botDisplayName: 'Bot',
  muteDurationMs: 12 * 60 * 60 * 1000, // 12 hours
  authDirRoot: './auth_info',

  // Subscription plans
  plans: {
    free: {
      name: 'Free',
      priceId: null, // no Stripe price
      maxBots: 1,
      features: ['1 WhatsApp bot', 'Anti-link moderation', 'Basic dashboard'],
    },
    pro: {
      name: 'Pro',
      priceId: null, // set via Stripe dashboard — user provides STRIPE_PRO_PRICE_ID
      maxBots: 5,
      features: ['Up to 5 bots', 'Anti-link & anti-abuse', 'Scheduled announcements', 'Quiz system', 'Greeter', 'Group lock/unlock'],
    },
    business: {
      name: 'Business',
      priceId: null,
      maxBots: -1, // unlimited
      features: ['Unlimited bots', 'All Pro features', 'Priority support', 'Custom roles'],
    },
  },

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
