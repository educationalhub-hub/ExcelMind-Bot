import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from './db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const COOKIE_NAME = 'em_token';
const TOKEN_TTL = '7d';

export function authRouter() {
  const router = express.Router();

  // Sign up
  router.post('/signup', async (req, res) => {
    const { email, password, name } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    try {
      const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
      if (existing.rows.length) {
        return res.status(409).json({ error: 'An account with this email already exists' });
      }

      // First user becomes founder/admin
      const userCount = await pool.query('SELECT COUNT(*) FROM users');
      const isFirstUser = parseInt(userCount.rows[0].count, 10) === 0;
      const role = isFirstUser ? 'founder' : 'user';

      const hash = await bcrypt.hash(password, 10);
      const result = await pool.query(
        'INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, $4) RETURNING id, email, name, plan, role',
        [email.toLowerCase(), hash, name || null, role],
      );
      const user = result.rows[0];
      const token = jwt.sign({ uid: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: TOKEN_TTL });
      res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });
      res.json({ user });
    } catch (err) {
      console.error('Signup error:', err.message);
      res.status(500).json({ error: 'Failed to create account' });
    }
  });

  // Log in
  router.post('/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    try {
      const result = await pool.query('SELECT id, email, name, password_hash, plan, role, is_active FROM users WHERE email = $1', [email.toLowerCase()]);
      if (!result.rows.length) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const user = result.rows[0];
      if (!user.is_active) {
        return res.status(403).json({ error: 'Your account has been deactivated. Please contact support.' });
      }

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const token = jwt.sign({ uid: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: TOKEN_TTL });
      res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });
      res.json({ user: { id: user.id, email: user.email, name: user.name, plan: user.plan, role: user.role } });
    } catch (err) {
      console.error('Login error:', err.message);
      res.status(500).json({ error: 'Failed to log in' });
    }
  });

  // Log out
  router.post('/logout', (req, res) => {
    res.clearCookie(COOKIE_NAME);
    res.json({ success: true });
  });

  // Get current user (fetch latest role from DB, in case JWT is stale)
  router.get('/me', requireAuth, async (req, res) => {
    try {
      const result = await pool.query('SELECT id, email, name, plan, role, is_active FROM users WHERE id = $1', [req.user.id]);
      if (!result.rows.length) return res.status(401).json({ error: 'User not found' });
      const user = result.rows[0];
      if (!user.is_active) return res.status(403).json({ error: 'Account deactivated' });
      res.json({ user: { id: user.id, email: user.email, name: user.name, plan: user.plan, role: user.role } });
    } catch {
      res.status(500).json({ error: 'Failed to fetch user' });
    }
  });

  return router;
}

// Auth middleware
export function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = { id: decoded.uid, email: decoded.email, role: decoded.role || 'user' };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

// Admin middleware — requires founder or admin role
export function requireAdmin(req, res, next) {
  if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'founder')) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

export { COOKIE_NAME };
