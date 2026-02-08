import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';

const router = Router();
const prisma = new PrismaClient();

// Admin middleware
async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token provided' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret') as { userId: string };
    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    
    if (!user || !user.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    (req as any).user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// GET /api/admin/dashboard - Overview stats
router.get('/dashboard', requireAdmin, async (req: Request, res: Response) => {
  try {
    const [totalUsers, totalOrders, totalDeliverers, activeOrders, recentOrders] = await Promise.all([
      prisma.user.count(),
      prisma.order.count(),
      prisma.user.count({ where: { isDeliverer: true } }),
      prisma.order.count({ where: { status: { in: ['PENDING', 'ACCEPTED', 'PICKING_UP', 'PICKED_UP', 'DELIVERING'] } } }),
      prisma.order.findMany({
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: {
          customer: { select: { id: true, firstName: true, lastName: true, email: true } },
          deliverer: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
      }),
    ]);

    res.json({
      stats: { totalUsers, totalOrders, totalDeliverers, activeOrders },
      recentOrders,
    });
  } catch (err) {
    console.error('Admin dashboard error:', err);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// GET /api/admin/users - List all users
router.get('/users', requireAdmin, async (req: Request, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        isVerified: true,
        isAdmin: true,
        isDeliverer: true,
        delivererRating: true,
        totalDeliveries: true,
        totalOrders: true,
        createdAt: true,
      },
    });
    res.json({ users });
  } catch (err) {
    console.error('Admin users error:', err);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

// GET /api/admin/orders - List all orders
router.get('/orders', requireAdmin, async (req: Request, res: Response) => {
  try {
    const orders = await prisma.order.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, email: true } },
        deliverer: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });
    res.json({ orders });
  } catch (err) {
    console.error('Admin orders error:', err);
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

// PATCH /api/admin/users/:id - Update user (verify, make admin, make deliverer)
router.patch('/users/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { isVerified, isAdmin, isDeliverer } = req.body;

    const updateData: any = {};
    if (typeof isVerified === 'boolean') updateData.isVerified = isVerified;
    if (typeof isAdmin === 'boolean') updateData.isAdmin = isAdmin;
    if (typeof isDeliverer === 'boolean') updateData.isDeliverer = isDeliverer;

    const user = await prisma.user.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        isVerified: true,
        isAdmin: true,
        isDeliverer: true,
      },
    });

    res.json({ user });
  } catch (err) {
    console.error('Admin update user error:', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// DELETE /api/admin/orders/:id - Cancel/delete an order
router.delete('/orders/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.order.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Admin delete order error:', err);
    res.status(500).json({ error: 'Failed to cancel order' });
  }
});

export default router;
