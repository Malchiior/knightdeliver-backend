import { Router } from 'express';
import { prisma } from '../utils/prisma';
import { authMiddleware } from '../middleware/auth';

const router = Router();

// Get deliverer stats
router.get('/stats', authMiddleware, async (req, res, next) => {
  try {
    const userId = (req as any).userId;
    
    // Get today's deliveries
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todayDeliveries = await prisma.order.count({
      where: {
        delivererId: userId,
        status: 'DELIVERED',
        deliveredAt: { gte: today },
      },
    });
    
    // Get total earnings (from tips)
    const earnings = await prisma.order.aggregate({
      where: {
        delivererId: userId,
        status: 'DELIVERED',
        deliveredAt: { gte: today },
      },
      _sum: { actualTip: true },
    });
    
    // Get user stats
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        delivererRating: true,
        totalDeliveries: true,
      },
    });
    
    res.json({
      todayDeliveries,
      todayEarnings: earnings._sum.actualTip || 0,
      totalDeliveries: user?.totalDeliveries || 0,
      rating: user?.delivererRating || 0,
    });
  } catch (error) {
    next(error);
  }
});

// Get deliverer's active order
router.get('/active', authMiddleware, async (req, res, next) => {
  try {
    const userId = (req as any).userId;
    
    const activeOrder = await prisma.order.findFirst({
      where: {
        delivererId: userId,
        status: { in: ['ACCEPTED', 'PICKING_UP', 'PICKED_UP', 'DELIVERING'] },
      },
      include: {
        customer: {
          select: { firstName: true, phone: true },
        },
        tracking: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });
    
    res.json({ activeOrder });
  } catch (error) {
    next(error);
  }
});

// Get delivery history
router.get('/history', authMiddleware, async (req, res, next) => {
  try {
    const userId = (req as any).userId;
    const { limit = 20, offset = 0 } = req.query;
    
    const deliveries = await prisma.order.findMany({
      where: {
        delivererId: userId,
        status: 'DELIVERED',
      },
      include: {
        customer: {
          select: { firstName: true },
        },
        rating: true,
      },
      orderBy: { deliveredAt: 'desc' },
      take: Number(limit),
      skip: Number(offset),
    });
    
    res.json({ deliveries });
  } catch (error) {
    next(error);
  }
});

// Become a deliverer
router.post('/register', authMiddleware, async (req, res, next) => {
  try {
    const userId = (req as any).userId;
    
    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        isDeliverer: true,
        delivererRating: 5.0, // Start with perfect rating
      },
    });
    
    res.json({
      message: 'You are now registered as a deliverer!',
      isDeliverer: user.isDeliverer,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
