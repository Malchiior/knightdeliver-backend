import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { authMiddleware } from '../middleware/auth';

const router = Router();

// Get io instance from app
const getIO = (req: any) => req.app.get('io');

// Create order (authenticated)
const createOrderSchema = z.object({
  restaurant: z.string().min(1),
  orderImageUrl: z.string().optional(),
  pickupLocation: z.string().min(1),
  dropoffBuilding: z.string().min(1),
  dropoffRoom: z.string().optional(),
  notes: z.string().optional(),
  estimatedTip: z.string().optional(),
});

router.post('/', authMiddleware, async (req, res, next) => {
  try {
    const data = createOrderSchema.parse(req.body);
    const userId = (req as any).userId;
    const io = getIO(req);
    
    const order = await prisma.order.create({
      data: {
        ...data,
        customerId: userId,
      },
      include: {
        customer: {
          select: { firstName: true, lastName: true },
        },
      },
    });
    
    // Create initial tracking
    await prisma.orderTracking.create({
      data: {
        orderId: order.id,
        status: 'PENDING',
        note: 'Order placed',
      },
    });
    
    // Notify available deliverers
    if (io) {
      io.emit('new-order', {
        id: order.id,
        restaurant: order.restaurant,
        pickupLocation: order.pickupLocation,
        dropoffBuilding: order.dropoffBuilding,
        estimatedTip: order.estimatedTip,
      });
    }
    
    res.status(201).json({ order });
  } catch (error) {
    next(error);
  }
});

// Create anonymous order (no auth required - for testing/MVP)
const createAnonymousOrderSchema = z.object({
  customerName: z.string().min(1),
  customerPhone: z.string().min(1),
  restaurant: z.string().min(1),
  pickupLocation: z.string().min(1),
  dropoffBuilding: z.string().min(1),
  dropoffRoom: z.string().optional(),
  items: z.string().optional(),
  hasDrink: z.boolean().optional(),
  notes: z.string().optional(),
  estimatedTip: z.string().optional(),
  isGroupOrder: z.boolean().optional(),
  groupSize: z.number().optional(),
});

router.post('/anonymous', async (req, res, next) => {
  try {
    const data = createAnonymousOrderSchema.parse(req.body);
    const io = getIO(req);
    
    // Create or find anonymous user
    let anonUser = await prisma.user.findFirst({
      where: { email: 'anonymous@knightdeliver.com' }
    });
    
    if (!anonUser) {
      anonUser = await prisma.user.create({
        data: {
          email: 'anonymous@knightdeliver.com',
          passwordHash: 'anonymous',
          firstName: 'Anonymous',
          lastName: 'User',
        }
      });
    }
    
    const order = await prisma.order.create({
      data: {
        restaurant: data.restaurant,
        pickupLocation: data.pickupLocation,
        dropoffBuilding: data.dropoffBuilding,
        dropoffRoom: data.dropoffRoom,
        notes: data.notes ? 
          `Name: ${data.customerName}\nPhone: ${data.customerPhone}\nItems: ${data.items || 'N/A'}\nDrink: ${data.hasDrink ? 'Yes' : 'No'}\n${data.notes}` :
          `Name: ${data.customerName}\nPhone: ${data.customerPhone}\nItems: ${data.items || 'N/A'}\nDrink: ${data.hasDrink ? 'Yes' : 'No'}`,
        estimatedTip: data.estimatedTip,
        customerId: anonUser.id,
      },
    });
    
    // Create initial tracking
    await prisma.orderTracking.create({
      data: {
        orderId: order.id,
        status: 'PENDING',
        note: 'Order placed',
      },
    });
    
    // Notify available deliverers
    if (io) {
      io.to('deliverers').emit('new-order', {
        id: order.id,
        customerName: data.customerName,
        customerPhone: data.customerPhone,
        restaurant: order.restaurant,
        pickupLocation: order.pickupLocation,
        dropoffBuilding: order.dropoffBuilding,
        dropoffRoom: order.dropoffRoom,
        estimatedTip: order.estimatedTip,
        items: data.items,
        hasDrink: data.hasDrink,
        createdAt: order.createdAt,
      });
    }
    
    res.status(201).json({ 
      order: {
        id: order.id,
        status: order.status,
        restaurant: order.restaurant,
        pickupLocation: order.pickupLocation,
        dropoffBuilding: order.dropoffBuilding,
        estimatedTip: order.estimatedTip,
      }
    });
  } catch (error) {
    next(error);
  }
});

// Get available orders (for deliverers)
router.get('/available', authMiddleware, async (req, res, next) => {
  try {
    const orders = await prisma.order.findMany({
      where: { status: 'PENDING' },
      include: {
        customer: {
          select: { firstName: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    
    res.json({ orders });
  } catch (error) {
    next(error);
  }
});

// Get user's orders
router.get('/my-orders', authMiddleware, async (req, res, next) => {
  try {
    const userId = (req as any).userId;
    
    const orders = await prisma.order.findMany({
      where: { customerId: userId },
      include: {
        deliverer: {
          select: { firstName: true, delivererRating: true },
        },
        tracking: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    
    res.json({ orders });
  } catch (error) {
    next(error);
  }
});

// Get single order (authenticated)
router.get('/:id', authMiddleware, async (req, res, next) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: {
        customer: {
          select: { firstName: true, lastName: true, phone: true },
        },
        deliverer: {
          select: { firstName: true, lastName: true, phone: true, delivererRating: true },
        },
        tracking: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    res.json({ order });
  } catch (error) {
    next(error);
  }
});

// Get single order (public - for tracking)
router.get('/:id/public', async (req, res, next) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: {
        tracking: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    // Parse notes for customer info
    const notes = order.notes || '';
    const nameMatch = notes.match(/Name: (.+)/);
    const phoneMatch = notes.match(/Phone: (.+)/);
    
    res.json({ 
      order: {
        id: order.id,
        status: order.status,
        restaurant: order.restaurant,
        pickupLocation: order.pickupLocation,
        dropoffBuilding: order.dropoffBuilding,
        dropoffRoom: order.dropoffRoom,
        estimatedTip: order.estimatedTip,
        createdAt: order.createdAt,
        customer: {
          firstName: nameMatch ? nameMatch[1].split('\n')[0] : 'Customer',
          phone: phoneMatch ? phoneMatch[1].split('\n')[0] : '',
        },
        tracking: order.tracking,
      }
    });
  } catch (error) {
    next(error);
  }
});

// Accept order (deliverer)
router.post('/:id/accept', authMiddleware, async (req, res, next) => {
  try {
    const userId = (req as any).userId;
    const orderId = req.params.id;
    
    // Check if user is a deliverer
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.isDeliverer) {
      return res.status(403).json({ error: 'Must be a registered deliverer' });
    }
    
    // Update order
    const order = await prisma.order.update({
      where: { id: orderId, status: 'PENDING' },
      data: {
        status: 'ACCEPTED',
        delivererId: userId,
      },
    });
    
    // Add tracking
    await prisma.orderTracking.create({
      data: {
        orderId,
        status: 'ACCEPTED',
        note: 'Deliverer assigned',
      },
    });
    
    // Notify customer
    const io = getIO(req);
    if (io) {
      io.to(`order-${orderId}`).emit('order-update', {
        status: 'ACCEPTED',
        deliverer: { firstName: user.firstName, rating: user.delivererRating },
      });
    }
    
    res.json({ order });
  } catch (error) {
    next(error);
  }
});

// Update order status
router.post('/:id/status', authMiddleware, async (req, res, next) => {
  try {
    const { status, latitude, longitude, note } = req.body;
    const orderId = req.params.id;
    
    const order = await prisma.order.update({
      where: { id: orderId },
      data: {
        status,
        ...(status === 'PICKED_UP' && { pickedUpAt: new Date() }),
        ...(status === 'DELIVERED' && { deliveredAt: new Date() }),
      },
    });
    
    // Add tracking
    await prisma.orderTracking.create({
      data: {
        orderId,
        status,
        latitude,
        longitude,
        note,
      },
    });
    
    // Notify customer
    const io = getIO(req);
    if (io) {
      io.to(`order-${orderId}`).emit('order-update', { status, latitude, longitude });
    }
    
    res.json({ order });
  } catch (error) {
    next(error);
  }
});

// Get available orders (public - for deliverers without auth for now)
router.get('/available-public', async (req, res, next) => {
  try {
    const orders = await prisma.order.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
    
    // Parse notes to extract customer info
    const formattedOrders = orders.map(order => {
      const notes = order.notes || '';
      const nameMatch = notes.match(/Name: (.+)/);
      const phoneMatch = notes.match(/Phone: (.+)/);
      const itemsMatch = notes.match(/Items: (.+)/);
      const drinkMatch = notes.match(/Drink: (.+)/);
      
      return {
        id: order.id,
        customerName: nameMatch ? nameMatch[1].split('\n')[0] : 'Customer',
        customerPhone: phoneMatch ? phoneMatch[1].split('\n')[0] : '',
        restaurant: order.restaurant,
        pickupLocation: order.pickupLocation,
        dropoffBuilding: order.dropoffBuilding,
        dropoffRoom: order.dropoffRoom,
        items: itemsMatch ? itemsMatch[1].split('\n')[0] : '',
        hasDrink: drinkMatch ? drinkMatch[1].trim().toLowerCase() === 'yes' : false,
        estimatedTip: order.estimatedTip,
        createdAt: order.createdAt,
      };
    });
    
    res.json({ orders: formattedOrders });
  } catch (error) {
    next(error);
  }
});

// Accept order (public - for testing)
router.post('/:id/accept-public', async (req, res, next) => {
  try {
    const { delivererName } = req.body;
    const orderId = req.params.id;
    const io = getIO(req);
    
    // Check order exists and is pending
    const existingOrder = await prisma.order.findUnique({
      where: { id: orderId }
    });
    
    if (!existingOrder) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    if (existingOrder.status !== 'PENDING') {
      return res.status(400).json({ error: 'Order already taken' });
    }
    
    // Update order
    const order = await prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'ACCEPTED',
      },
    });
    
    // Add tracking
    await prisma.orderTracking.create({
      data: {
        orderId,
        status: 'ACCEPTED',
        note: `Accepted by ${delivererName || 'Knight'}`,
      },
    });
    
    // Notify customer
    if (io) {
      io.to(`order-${orderId}`).emit('order-update', {
        status: 'ACCEPTED',
        deliverer: { firstName: delivererName || 'Knight' },
      });
    }
    
    res.json({ order });
  } catch (error) {
    next(error);
  }
});

// Update order status (public - for testing)
router.post('/:id/status-public', async (req, res, next) => {
  try {
    const { status, latitude, longitude, note, delivererName } = req.body;
    const orderId = req.params.id;
    const io = getIO(req);
    
    const order = await prisma.order.update({
      where: { id: orderId },
      data: {
        status,
        ...(status === 'PICKED_UP' && { pickedUpAt: new Date() }),
        ...(status === 'DELIVERED' && { deliveredAt: new Date() }),
      },
    });
    
    // Add tracking
    await prisma.orderTracking.create({
      data: {
        orderId,
        status,
        latitude,
        longitude,
        note: note || `Status updated by ${delivererName || 'Knight'}`,
      },
    });
    
    // Notify customer
    if (io) {
      io.to(`order-${orderId}`).emit('order-update', { 
        status, 
        latitude, 
        longitude,
        deliverer: { firstName: delivererName || 'Knight' },
      });
    }
    
    res.json({ order });
  } catch (error) {
    next(error);
  }
});

export default router;
