import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { authMiddleware } from '../middleware/auth';

const router = Router();

// Update profile
const updateProfileSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().optional(),
});

router.put('/profile', authMiddleware, async (req, res, next) => {
  try {
    const userId = (req as any).userId;
    const data = updateProfileSchema.parse(req.body);
    
    const user = await prisma.user.update({
      where: { id: userId },
      data,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        isVerified: true,
        isDeliverer: true,
      },
    });
    
    res.json({ user });
  } catch (error) {
    next(error);
  }
});

// Get saved locations
router.get('/locations', authMiddleware, async (req, res, next) => {
  try {
    const userId = (req as any).userId;
    
    const locations = await prisma.savedLocation.findMany({
      where: { userId },
      orderBy: { isDefault: 'desc' },
    });
    
    res.json({ locations });
  } catch (error) {
    next(error);
  }
});

// Add saved location
router.post('/locations', authMiddleware, async (req, res, next) => {
  try {
    const userId = (req as any).userId;
    const { name, building, room, isDefault } = req.body;
    
    // If setting as default, unset other defaults
    if (isDefault) {
      await prisma.savedLocation.updateMany({
        where: { userId },
        data: { isDefault: false },
      });
    }
    
    const location = await prisma.savedLocation.create({
      data: {
        name,
        building,
        room,
        isDefault: isDefault || false,
        userId,
      },
    });
    
    res.status(201).json({ location });
  } catch (error) {
    next(error);
  }
});

// Delete saved location
router.delete('/locations/:id', authMiddleware, async (req, res, next) => {
  try {
    const userId = (req as any).userId;
    
    await prisma.savedLocation.delete({
      where: { id: req.params.id, userId },
    });
    
    res.json({ message: 'Location deleted' });
  } catch (error) {
    next(error);
  }
});

// Rate a delivery/ride
router.post('/rate', authMiddleware, async (req, res, next) => {
  try {
    const userId = (req as any).userId;
    const { score, comment, orderId, rideId, rateeId } = req.body;
    
    const rating = await prisma.rating.create({
      data: {
        score,
        comment,
        raterId: userId,
        rateeId,
        orderId,
        rideId,
      },
    });
    
    // Update deliverer's average rating
    const ratings = await prisma.rating.findMany({
      where: { rateeId },
      select: { score: true },
    });
    
    const avgRating = ratings.reduce((sum, r) => sum + r.score, 0) / ratings.length;
    
    await prisma.user.update({
      where: { id: rateeId },
      data: { delivererRating: Math.round(avgRating * 10) / 10 },
    });
    
    res.status(201).json({ rating });
  } catch (error) {
    next(error);
  }
});

export default router;
