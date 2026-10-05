import { pool } from './db.js';

/**
 * Insert an in-dashboard notification for the bot's owner.
 * @param {number|null} userId - The owning user's id (null/undefined → unowned bot, skip)
 * @param {string} message - Human-readable notification text
 */
export async function notifyOwner(userId, message) {
  if (!userId) return;
  try {
    await pool.query(
      'INSERT INTO notifications (user_id, message) VALUES ($1, $2)',
      [userId, message],
    );
  } catch (e) {
    console.error('❌ Failed to create owner notification:', e.message);
  }
}
