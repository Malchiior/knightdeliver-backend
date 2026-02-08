import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { logger } from '../utils/logger';

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

// ============================================================
// DASHBOARD
// ============================================================

router.get('/dashboard', requireAdmin, async (req: Request, res: Response) => {
  try {
    const [
      totalUsers, totalOrders, totalDeliverers, activeOrders,
      pendingChargers, totalDelivered, recentOrders, cancelledOrders
    ] = await Promise.all([
      prisma.user.count(),
      prisma.order.count(),
      prisma.user.count({ where: { isDeliverer: true } }),
      prisma.order.count({ where: { status: { in: ['PENDING', 'ACCEPTED', 'PICKING_UP', 'PICKED_UP', 'DELIVERING'] } } }),
      prisma.user.count({ where: { chargerStatus: 'pending' } }),
      prisma.order.count({ where: { status: 'DELIVERED' } }),
      prisma.order.findMany({
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: {
          customer: { select: { id: true, firstName: true, lastName: true, email: true } },
          deliverer: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
      }),
      prisma.order.count({ where: { status: 'CANCELLED' } }),
    ]);

    // Revenue stats
    const deliveredOrders = await prisma.order.findMany({
      where: { status: 'DELIVERED', deliveryFee: { not: null } },
      select: { deliveryFee: true },
    });
    const totalRevenue = deliveredOrders.reduce((sum, o) => sum + (o.deliveryFee || 0), 0);
    const avgOrderFee = deliveredOrders.length > 0 ? totalRevenue / deliveredOrders.length : 0;

    // Orders by hour (for peak hours)
    const allOrders = await prisma.order.findMany({ select: { createdAt: true } });
    const hourCounts: Record<number, number> = {};
    allOrders.forEach(o => {
      const hour = new Date(o.createdAt).getHours();
      hourCounts[hour] = (hourCounts[hour] || 0) + 1;
    });

    // Get settings
    let settings = await prisma.appSettings.findUnique({ where: { id: 'settings' } });
    if (!settings) {
      settings = await prisma.appSettings.create({ data: { id: 'settings' } });
    }

    res.json({
      stats: {
        totalUsers, totalOrders, totalDeliverers, activeOrders,
        pendingChargers, totalDelivered, cancelledOrders,
        totalRevenue: totalRevenue.toFixed(2),
        avgOrderFee: avgOrderFee.toFixed(2),
      },
      peakHours: hourCounts,
      settings: { maxChargers: settings.maxChargers, autoApprove: settings.autoApprove },
      recentOrders,
    });
  } catch (err) {
    logger.error('Admin dashboard error:', err);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// ============================================================
// USERS
// ============================================================

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
        chargerStatus: true,
        profileImage: true,
        studentIdUrl: true,
        studentIdSubmittedAt: true,
        delivererRating: true,
        totalDeliveries: true,
        totalOrders: true,
        totalEarnings: true,
        createdAt: true,
      },
    });
    res.json({ users });
  } catch (err) {
    logger.error('Admin users error:', err);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

// Get single user detail with order history
router.get('/users/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: {
        ordersPlaced: {
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: {
            id: true, status: true, restaurant: true, pickupLocation: true,
            dropoffBuilding: true, deliveryFee: true, createdAt: true,
          },
        },
        ordersDelivered: {
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: {
            id: true, status: true, restaurant: true, pickupLocation: true,
            dropoffBuilding: true, deliveryFee: true, createdAt: true,
          },
        },
        ratingsReceived: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: { id: true, score: true, comment: true, createdAt: true },
        },
      },
    });

    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({ user });
  } catch (err) {
    logger.error('Admin user detail error:', err);
    res.status(500).json({ error: 'Failed to load user' });
  }
});

// Update user (verify, admin, deliverer status)
router.patch('/users/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { isVerified, isAdmin, isDeliverer, chargerStatus } = req.body;

    const updateData: any = {};
    if (typeof isVerified === 'boolean') updateData.isVerified = isVerified;
    if (typeof isAdmin === 'boolean') updateData.isAdmin = isAdmin;
    if (typeof isDeliverer === 'boolean') updateData.isDeliverer = isDeliverer;
    if (typeof chargerStatus === 'string') updateData.chargerStatus = chargerStatus;

    // If approving charger, also set isDeliverer
    if (chargerStatus === 'approved') {
      updateData.isDeliverer = true;
    }
    if (chargerStatus === 'denied') {
      updateData.isDeliverer = false;
    }

    const user = await prisma.user.update({
      where: { id },
      data: updateData,
      select: {
        id: true, email: true, firstName: true, lastName: true,
        isVerified: true, isAdmin: true, isDeliverer: true,
        chargerStatus: true, studentIdUrl: true,
      },
    });

    logger.info(`Admin updated user ${user.email}: ${JSON.stringify(updateData)}`);
    res.json({ user });
  } catch (err) {
    logger.error('Admin update user error:', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// ============================================================
// CHARGER APPLICATIONS
// ============================================================

// Get pending charger applications
router.get('/charger-applications', requireAdmin, async (req: Request, res: Response) => {
  try {
    const applications = await prisma.user.findMany({
      where: { chargerStatus: 'pending' },
      orderBy: { studentIdSubmittedAt: 'desc' },
      select: {
        id: true, email: true, firstName: true, lastName: true,
        phone: true, studentIdUrl: true, studentIdSubmittedAt: true,
        isVerified: true, createdAt: true,
      },
    });
    res.json({ applications });
  } catch (err) {
    logger.error('Charger applications error:', err);
    res.status(500).json({ error: 'Failed to load applications' });
  }
});

// Approve/deny charger application
router.post('/charger-applications/:id/review', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { action } = req.body; // 'approve' or 'deny'

    if (action === 'approve') {
      // Check charger cap
      const settings = await prisma.appSettings.findUnique({ where: { id: 'settings' } });
      const currentChargers = await prisma.user.count({ where: { isDeliverer: true } });
      
      if (settings && currentChargers >= settings.maxChargers) {
        return res.status(400).json({ error: `Max charger limit reached (${settings.maxChargers})` });
      }

      await prisma.user.update({
        where: { id },
        data: { chargerStatus: 'approved', isDeliverer: true, isVerified: true },
      });
      logger.info(`Charger approved: ${id}`);
    } else if (action === 'deny') {
      await prisma.user.update({
        where: { id },
        data: { chargerStatus: 'denied', isDeliverer: false },
      });
      logger.info(`Charger denied: ${id}`);
    }

    res.json({ success: true });
  } catch (err) {
    logger.error('Review charger error:', err);
    res.status(500).json({ error: 'Failed to review application' });
  }
});

// ============================================================
// CHARGER STATS
// ============================================================

router.get('/chargers', requireAdmin, async (req: Request, res: Response) => {
  try {
    const chargers = await prisma.user.findMany({
      where: { isDeliverer: true },
      orderBy: { totalDeliveries: 'desc' },
      select: {
        id: true, email: true, firstName: true, lastName: true,
        isVerified: true, chargerStatus: true,
        delivererRating: true, totalDeliveries: true, totalEarnings: true,
        createdAt: true,
        ratingsReceived: {
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: { score: true, comment: true, createdAt: true },
        },
      },
    });
    res.json({ chargers });
  } catch (err) {
    logger.error('Chargers list error:', err);
    res.status(500).json({ error: 'Failed to load chargers' });
  }
});

// ============================================================
// ORDERS
// ============================================================

router.get('/orders', requireAdmin, async (req: Request, res: Response) => {
  try {
    const orders = await prisma.order.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, email: true } },
        deliverer: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });
    res.json({ orders });
  } catch (err) {
    logger.error('Admin orders error:', err);
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

// Cancel order
router.delete('/orders/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    await prisma.order.update({
      where: { id: req.params.id },
      data: { status: 'CANCELLED' },
    });
    res.json({ success: true });
  } catch (err) {
    logger.error('Admin cancel order error:', err);
    res.status(500).json({ error: 'Failed to cancel order' });
  }
});

// ============================================================
// SETTINGS
// ============================================================

router.get('/settings', requireAdmin, async (req: Request, res: Response) => {
  try {
    let settings = await prisma.appSettings.findUnique({ where: { id: 'settings' } });
    if (!settings) {
      settings = await prisma.appSettings.create({ data: { id: 'settings' } });
    }
    res.json({ settings });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

router.patch('/settings', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { maxChargers, autoApprove } = req.body;
    const updateData: any = {};
    if (typeof maxChargers === 'number') updateData.maxChargers = maxChargers;
    if (typeof autoApprove === 'boolean') updateData.autoApprove = autoApprove;

    const settings = await prisma.appSettings.upsert({
      where: { id: 'settings' },
      update: updateData,
      create: { id: 'settings', ...updateData },
    });

    logger.info(`Admin updated settings: ${JSON.stringify(updateData)}`);
    res.json({ settings });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ============================================================
// EXPORT (CSV)
// ============================================================

router.get('/export/users', requireAdmin, async (req: Request, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        email: true, firstName: true, lastName: true, phone: true,
        isVerified: true, isDeliverer: true, chargerStatus: true,
        totalOrders: true, totalDeliveries: true, totalEarnings: true,
        delivererRating: true, createdAt: true,
      },
    });
    
    const header = 'Email,First Name,Last Name,Phone,Verified,Charger,Status,Orders,Deliveries,Earnings,Rating,Joined';
    const rows = users.map(u => 
      `${u.email},${u.firstName},${u.lastName},${u.phone || ''},${u.isVerified},${u.isDeliverer},${u.chargerStatus},${u.totalOrders},${u.totalDeliveries},${u.totalEarnings},${u.delivererRating || ''},${u.createdAt.toISOString()}`
    );
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=knightdeliver-users.csv');
    res.send([header, ...rows].join('\n'));
  } catch (err) {
    res.status(500).json({ error: 'Failed to export' });
  }
});

router.get('/export/orders', requireAdmin, async (req: Request, res: Response) => {
  try {
    const orders = await prisma.order.findMany({
      include: {
        customer: { select: { email: true, firstName: true, lastName: true } },
        deliverer: { select: { email: true, firstName: true, lastName: true } },
      },
    });
    
    const header = 'ID,Status,Restaurant,Pickup,Delivery,Fee,Payment,Customer,Charger,Created';
    const rows = orders.map(o =>
      `${o.id},${o.status},${o.restaurant},${o.pickupLocation},${o.dropoffBuilding},${o.deliveryFee || ''},${o.paymentMethod || ''},${o.customer ? o.customer.email : 'anon'},${o.deliverer ? o.deliverer.email : ''},${o.createdAt.toISOString()}`
    );
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=knightdeliver-orders.csv');
    res.send([header, ...rows].join('\n'));
  } catch (err) {
    res.status(500).json({ error: 'Failed to export' });
  }
});

export default router;
