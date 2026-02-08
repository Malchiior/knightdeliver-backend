import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { logger } from '../utils/logger';
import { 
  generateVerificationCode, 
  sendVerificationEmail,
  sendWelcomeEmail 
} from '../services/email';

const router = Router();

// In-memory store for verification codes (use Redis in production)
const verificationCodes = new Map<string, { code: string; expiresAt: Date }>();

// Validation schemas
const registerSchema = z.object({
  email: z.string().email().refine(
    (email) => email.endsWith('@ucf.edu') || email.endsWith('@knights.ucf.edu'),
    { message: 'Must use a @ucf.edu email' }
  ),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  name: z.string().min(1, 'Name is required'),
  phone: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

const verifyCodeSchema = z.object({
  email: z.string().email(),
  code: z.string().length(6),
});

// Helper to split name into first/last
function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: '' };
  }
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' '),
  };
}

// Register
router.post('/register', async (req, res, next) => {
  try {
    const data = registerSchema.parse(req.body);
    const { firstName, lastName } = splitName(data.name);
    
    // Check if user exists
    const existing = await prisma.user.findUnique({
      where: { email: data.email.toLowerCase() },
    });
    
    if (existing) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    
    // Hash password
    const passwordHash = await bcrypt.hash(data.password, 10);
    
    // Create user
    const user = await prisma.user.create({
      data: {
        email: data.email.toLowerCase(),
        passwordHash,
        firstName,
        lastName,
        phone: data.phone,
        isVerified: false, // Will be verified via email
      },
    });
    
    // Generate and send verification code
    const code = generateVerificationCode();
    verificationCodes.set(data.email.toLowerCase(), {
      code,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
    });
    
    // Send verification email (non-blocking)
    sendVerificationEmail(data.email, firstName, code).catch(err => {
      logger.error('Failed to send verification email:', err);
    });
    
    // Generate token
    const token = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET || 'dev-secret',
      { expiresIn: '7d' }
    );
    
    logger.info(`New user registered: ${data.email}`);
    
    res.status(201).json({
      user: {
        id: user.id,
        email: user.email,
        name: `${user.firstName} ${user.lastName}`.trim(),
        isVerified: user.isVerified,
      },
      token,
      message: 'Account created! Check your email for verification code.',
    });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ 
        error: error.errors[0]?.message || 'Validation failed' 
      });
    }
    next(error);
  }
});

// Login
router.post('/login', async (req, res, next) => {
  try {
    const data = loginSchema.parse(req.body);
    
    // Find user
    const user = await prisma.user.findUnique({
      where: { email: data.email.toLowerCase() },
    });
    
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    // Check password
    const validPassword = await bcrypt.compare(data.password, user.passwordHash);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    // Generate token
    const token = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET || 'dev-secret',
      { expiresIn: '7d' }
    );
    
    logger.info(`User logged in: ${data.email}`);
    
    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: `${user.firstName} ${user.lastName}`.trim(),
        phone: user.phone,
        isVerified: user.isVerified,
        isDeliverer: user.isDeliverer,
        isAdmin: user.isAdmin,
      },
      token,
    });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ 
        error: error.errors[0]?.message || 'Validation failed' 
      });
    }
    next(error);
  }
});

// Send verification code
router.post('/send-code', async (req, res, next) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (user.isVerified) {
      return res.status(400).json({ error: 'Email already verified' });
    }
    
    // Generate new code
    const code = generateVerificationCode();
    verificationCodes.set(email.toLowerCase(), {
      code,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    
    // Send email
    const sent = await sendVerificationEmail(email, user.firstName, code);
    
    if (!sent) {
      return res.status(500).json({ error: 'Failed to send verification email' });
    }
    
    res.json({ message: 'Verification code sent!' });
  } catch (error) {
    next(error);
  }
});

// Verify email with code
router.post('/verify', async (req, res, next) => {
  try {
    const data = verifyCodeSchema.parse(req.body);
    
    const stored = verificationCodes.get(data.email.toLowerCase());
    
    if (!stored) {
      return res.status(400).json({ error: 'No verification code found. Request a new one.' });
    }
    
    if (stored.expiresAt < new Date()) {
      verificationCodes.delete(data.email.toLowerCase());
      return res.status(400).json({ error: 'Verification code expired. Request a new one.' });
    }
    
    if (stored.code !== data.code) {
      return res.status(400).json({ error: 'Invalid verification code' });
    }
    
    // Mark user as verified
    const user = await prisma.user.update({
      where: { email: data.email.toLowerCase() },
      data: { isVerified: true },
    });
    
    // Clean up
    verificationCodes.delete(data.email.toLowerCase());
    
    // Send welcome email (non-blocking)
    sendWelcomeEmail(user.email, user.firstName).catch(err => {
      logger.error('Failed to send welcome email:', err);
    });
    
    logger.info(`User verified: ${data.email}`);
    
    res.json({ 
      message: 'Email verified successfully!',
      isVerified: true,
    });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ 
        error: error.errors[0]?.message || 'Validation failed' 
      });
    }
    next(error);
  }
});

// Resend verification code
router.post('/resend-code', async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.isVerified) return res.json({ message: 'Already verified' });

    const code = generateVerificationCode();
    verificationCodes.set(email.toLowerCase(), {
      code,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    sendVerificationEmail(email, user.firstName, code).catch(err => {
      logger.error('Failed to resend verification email:', err);
    });

    logger.info(`Verification code resent to ${email}`);
    res.json({ message: 'Verification code sent!' });
  } catch (error) {
    next(error);
  }
});

// Forgot password — send reset code
const resetCodes = new Map<string, { code: string; expiresAt: Date }>();

router.post('/forgot-password', async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user) {
      // Don't reveal if email exists
      return res.json({ message: 'If that email exists, a reset code has been sent.' });
    }

    const code = generateVerificationCode();
    resetCodes.set(email.toLowerCase(), {
      code,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    // Send reset email
    if (process.env.RESEND_API_KEY) {
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: 'KnightDeliver <noreply@knightdeliver.com>',
        to: email.toLowerCase(),
        subject: '🔑 Reset your KnightDeliver password',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background: #FFC904; padding: 20px; text-align: center; border-radius: 10px 10px 0 0;">
              <h1 style="color: #000; margin: 0;">⚔️ KnightDeliver</h1>
            </div>
            <div style="background: #1a1a1a; color: #fff; padding: 30px; border-radius: 0 0 10px 10px;">
              <h2 style="color: #FFC904;">Password Reset</h2>
              <p>Use this code to reset your password:</p>
              <div style="background: #000; padding: 20px; border-radius: 10px; text-align: center; margin: 20px 0;">
                <span style="font-size: 32px; font-weight: bold; color: #FFC904; letter-spacing: 8px;">${code}</span>
              </div>
              <p style="color: #888;">This code expires in 10 minutes.</p>
            </div>
          </div>
        `,
        text: `Your KnightDeliver password reset code is: ${code}. Expires in 10 minutes.`,
      }).catch((err: any) => logger.error('Reset email error:', err));
    } else {
      logger.info(`[DEV] Reset code for ${email}: ${code}`);
    }

    res.json({ message: 'If that email exists, a reset code has been sent.' });
  } catch (error) {
    next(error);
  }
});

// Reset password with code
router.post('/reset-password', async (req, res, next) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) return res.status(400).json({ error: 'All fields required' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const stored = resetCodes.get(email.toLowerCase());
    if (!stored) return res.status(400).json({ error: 'No reset code found. Request a new one.' });
    if (stored.expiresAt < new Date()) {
      resetCodes.delete(email.toLowerCase());
      return res.status(400).json({ error: 'Reset code expired. Request a new one.' });
    }
    if (stored.code !== code) return res.status(400).json({ error: 'Invalid reset code' });

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { email: email.toLowerCase() },
      data: { passwordHash },
    });

    resetCodes.delete(email.toLowerCase());
    logger.info(`Password reset for: ${email}`);
    res.json({ message: 'Password reset successfully!' });
  } catch (error) {
    next(error);
  }
});

// Get current user
router.get('/me', async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret') as { userId: string };
    
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        isVerified: true,
        isDeliverer: true,
        delivererRating: true,
        totalDeliveries: true,
        totalOrders: true,
      },
    });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({ 
      user: {
        ...user,
        name: `${user.firstName} ${user.lastName}`.trim(),
      }
    });
  } catch (error) {
    next(error);
  }
});

// Update profile
router.patch('/profile', async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret') as { userId: string };
    
    const { name, phone } = req.body;
    const updateData: any = {};
    
    if (name) {
      const { firstName, lastName } = splitName(name);
      updateData.firstName = firstName;
      updateData.lastName = lastName;
    }
    
    if (phone !== undefined) {
      updateData.phone = phone;
    }
    
    const user = await prisma.user.update({
      where: { id: decoded.userId },
      data: updateData,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        isVerified: true,
      },
    });
    
    res.json({ 
      user: {
        ...user,
        name: `${user.firstName} ${user.lastName}`.trim(),
      },
      message: 'Profile updated!',
    });
  } catch (error) {
    next(error);
  }
});

export default router;
