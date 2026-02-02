import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../utils/prisma';

// Extended request type with user info
export interface AuthRequest extends Request {
  userId?: string;
  user?: {
    id: string;
    email: string;
    name: string;
    isDeliverer: boolean;
    isVerified: boolean;
  };
}

// Simple auth middleware (just validates token)
export const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret') as { userId: string };

    (req as any).userId = decoded.userId;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Full auth middleware that loads user data
export const authenticate = async (req: AuthRequest, res: Response, next: NextFunction) => {
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
        isDeliverer: true,
        isVerified: true,
      },
    });

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    req.userId = user.id;
    req.user = {
      id: user.id,
      email: user.email,
      name: `${user.firstName} ${user.lastName}`,
      isDeliverer: user.isDeliverer,
      isVerified: user.isVerified,
    };

    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Middleware to require verified user
export const requireVerified = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user?.isVerified) {
    return res.status(403).json({ error: 'Email verification required' });
  }
  next();
};

// Middleware to require deliverer status
export const requireDeliverer = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user?.isDeliverer) {
    return res.status(403).json({ error: 'Deliverer status required' });
  }
  next();
};
