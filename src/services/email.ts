import { Resend } from 'resend';
import { logger } from '../utils/logger';

// Initialize Resend (API key from environment)
const resend = process.env.RESEND_API_KEY 
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

// Email templates
const templates = {
  verificationCode: (code: string, name: string) => ({
    subject: '🎓 Verify your KnightDeliver account',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: #FFC904; padding: 20px; text-align: center; border-radius: 10px 10px 0 0;">
          <h1 style="color: #000; margin: 0;">⚔️ KnightDeliver</h1>
          <p style="color: #000; margin: 5px 0 0;">By Knights, For Knights</p>
        </div>
        
        <div style="background: #1a1a1a; color: #fff; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #FFC904; margin-top: 0;">Hey ${name}! 👋</h2>
          <p>Welcome to KnightDeliver! Use this code to verify your UCF email:</p>
          
          <div style="background: #000; padding: 20px; border-radius: 10px; text-align: center; margin: 20px 0;">
            <span style="font-size: 32px; font-weight: bold; color: #FFC904; letter-spacing: 8px;">${code}</span>
          </div>
          
          <p style="color: #888;">This code expires in 10 minutes.</p>
          <p style="color: #888; font-size: 12px;">If you didn't request this, you can ignore this email.</p>
          
          <hr style="border: 1px solid #333; margin: 20px 0;">
          <p style="color: #666; font-size: 12px; text-align: center;">
            KnightDeliver - UCF Campus Delivery 🛴
          </p>
        </div>
      </div>
    `,
    text: `Hey ${name}! Your KnightDeliver verification code is: ${code}. This code expires in 10 minutes.`,
  }),

  welcomeEmail: (name: string) => ({
    subject: '🎉 Welcome to KnightDeliver!',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: #FFC904; padding: 20px; text-align: center; border-radius: 10px 10px 0 0;">
          <h1 style="color: #000; margin: 0;">⚔️ KnightDeliver</h1>
        </div>
        
        <div style="background: #1a1a1a; color: #fff; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #FFC904;">Welcome to the Knight family, ${name}! 🎓</h2>
          
          <p>You're now part of UCF's student-powered delivery network!</p>
          
          <h3 style="color: #FFC904;">What you can do:</h3>
          <ul style="color: #ccc;">
            <li>🍔 Order food from any campus restaurant</li>
            <li>💰 Earn money by delivering for fellow Knights</li>
            <li>🤝 Get hand-delivered orders (no drop-offs!)</li>
          </ul>
          
          <div style="background: #000; padding: 15px; border-radius: 10px; margin: 20px 0;">
            <p style="color: #FFC904; margin: 0; text-align: center;">
              <strong>Tip:</strong> Verify your UCF ID to build trust with other students!
            </p>
          </div>
          
          <p>Go Knights! ⚔️</p>
        </div>
      </div>
    `,
    text: `Welcome to KnightDeliver, ${name}! You're now part of UCF's student-powered delivery network. Go Knights!`,
  }),

  orderUpdate: (name: string, status: string, orderDetails: string) => ({
    subject: `📦 Order Update: ${status}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: #FFC904; padding: 15px; text-align: center; border-radius: 10px 10px 0 0;">
          <h2 style="color: #000; margin: 0;">Order Update</h2>
        </div>
        
        <div style="background: #1a1a1a; color: #fff; padding: 25px; border-radius: 0 0 10px 10px;">
          <p>Hey ${name}!</p>
          <p>Your order status: <strong style="color: #FFC904;">${status}</strong></p>
          <p style="color: #888;">${orderDetails}</p>
        </div>
      </div>
    `,
    text: `Hey ${name}! Your order status: ${status}. ${orderDetails}`,
  }),
};

// Generate 6-digit verification code
export function generateVerificationCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Send verification email
export async function sendVerificationEmail(
  email: string, 
  name: string, 
  code: string
): Promise<boolean> {
  if (!resend) {
    logger.warn('Resend not configured - skipping email');
    logger.info(`[DEV] Verification code for ${email}: ${code}`);
    return true; // Return true for dev mode
  }

  try {
    const template = templates.verificationCode(code, name);
    
    const { data, error } = await resend.emails.send({
      from: 'KnightDeliver <noreply@knightdeliver.com>',
      to: email,
      subject: template.subject,
      html: template.html,
      text: template.text,
    });

    if (error) {
      logger.error('Failed to send verification email:', error);
      return false;
    }

    logger.info(`Verification email sent to ${email}`, { emailId: data?.id });
    return true;
  } catch (error) {
    logger.error('Email service error:', error);
    return false;
  }
}

// Send welcome email
export async function sendWelcomeEmail(email: string, name: string): Promise<boolean> {
  if (!resend) {
    logger.warn('Resend not configured - skipping welcome email');
    return true;
  }

  try {
    const template = templates.welcomeEmail(name);
    
    const { error } = await resend.emails.send({
      from: 'KnightDeliver <noreply@knightdeliver.com>',
      to: email,
      subject: template.subject,
      html: template.html,
      text: template.text,
    });

    if (error) {
      logger.error('Failed to send welcome email:', error);
      return false;
    }

    return true;
  } catch (error) {
    logger.error('Email service error:', error);
    return false;
  }
}

// Send order update email
export async function sendOrderUpdateEmail(
  email: string,
  name: string,
  status: string,
  orderDetails: string
): Promise<boolean> {
  if (!resend) {
    logger.warn('Resend not configured - skipping order update email');
    return true;
  }

  try {
    const template = templates.orderUpdate(name, status, orderDetails);
    
    const { error } = await resend.emails.send({
      from: 'KnightDeliver <noreply@knightdeliver.com>',
      to: email,
      subject: template.subject,
      html: template.html,
      text: template.text,
    });

    if (error) {
      logger.error('Failed to send order update email:', error);
      return false;
    }

    return true;
  } catch (error) {
    logger.error('Email service error:', error);
    return false;
  }
}

export { templates };
