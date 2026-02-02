import { Router, Response } from 'express';
import { query, queryOne } from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { validate, locationUpdateValidation } from '../middleware/validation';
import { logger } from '../utils/logger';

const router = Router();

// Update location (for deliverers)
router.post('/location', authenticate, validate(locationUpdateValidation), asyncHandler(async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { orderId, latitude, longitude, accuracy } = req.body;

  // Verify user is the deliverer for this order
  const order = await queryOne(
    `SELECT * FROM orders WHERE id = $1 AND deliverer_id = $2 AND status IN ('accepted', 'picked_up', 'on_the_way')`,
    [orderId, userId]
  );

  if (!order) {
    res.status(403).json({ error: 'Not authorized to update location for this order' });
    return;
  }

  // Insert location update
  await query(
    `INSERT INTO location_updates (order_id, user_id, latitude, longitude, accuracy)
     VALUES ($1, $2, $3, $4, $5)`,
    [orderId, userId, latitude, longitude, accuracy]
  );

  // Emit real-time location update via socket
  const io = req.app.get('io');
  io.to(`order:${orderId}`).emit('location_update', {
    orderId,
    latitude,
    longitude,
    accuracy,
    timestamp: new Date().toISOString(),
  });

  res.json({ message: 'Location updated' });
}));

// Get latest location for an order
router.get('/order/:orderId/location', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { orderId } = req.params;
  const userId = req.user!.id;

  // Verify user is authorized to view this order
  const order = await queryOne(
    `SELECT * FROM orders WHERE id = $1 AND (customer_id = $2 OR deliverer_id = $2)`,
    [orderId, userId]
  );

  if (!order) {
    res.status(403).json({ error: 'Not authorized to view this order' });
    return;
  }

  // Get latest location
  const location = await queryOne(
    `SELECT latitude, longitude, accuracy, created_at as "timestamp"
     FROM location_updates
     WHERE order_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [orderId]
  );

  res.json({
    location: location || null,
    orderStatus: order.status,
  });
}));

// Get location history for an order
router.get('/order/:orderId/history', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { orderId } = req.params;
  const userId = req.user!.id;
  const limit = parseInt(req.query.limit as string) || 50;

  // Verify user is authorized
  const order = await queryOne(
    `SELECT * FROM orders WHERE id = $1 AND (customer_id = $2 OR deliverer_id = $2)`,
    [orderId, userId]
  );

  if (!order) {
    res.status(403).json({ error: 'Not authorized to view this order' });
    return;
  }

  // Get location history
  const locations = await query(
    `SELECT latitude, longitude, accuracy, created_at as "timestamp"
     FROM location_updates
     WHERE order_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [orderId, limit]
  );

  res.json({
    locations,
    orderStatus: order.status,
  });
}));

// Get active orders being tracked (for current user)
router.get('/active', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;

  // Get orders as customer
  const customerOrders = await query(
    `SELECT o.id, o.status, o.pickup_location as "pickupLocation", 
            o.delivery_building as "deliveryBuilding", o.delivery_room as "deliveryRoom",
            o.created_at as "createdAt", o.estimated_delivery_time as "estimatedDeliveryTime",
            d.name as "delivererName", d.deliverer_vehicle as "delivererVehicle",
            d.avg_rating as "delivererRating",
            l.latitude, l.longitude, l.created_at as "lastLocationUpdate"
     FROM orders o
     LEFT JOIN users d ON o.deliverer_id = d.id
     LEFT JOIN LATERAL (
       SELECT latitude, longitude, created_at FROM location_updates 
       WHERE order_id = o.id ORDER BY created_at DESC LIMIT 1
     ) l ON true
     WHERE o.customer_id = $1 AND o.status IN ('pending', 'accepted', 'picked_up', 'on_the_way')
     ORDER BY o.created_at DESC`,
    [userId]
  );

  // Get orders as deliverer
  const delivererOrders = await query(
    `SELECT o.id, o.status, o.pickup_location as "pickupLocation", 
            o.delivery_building as "deliveryBuilding", o.delivery_room as "deliveryRoom",
            o.special_instructions as "specialInstructions",
            o.created_at as "createdAt",
            c.name as "customerName", c.phone as "customerPhone"
     FROM orders o
     JOIN users c ON o.customer_id = c.id
     WHERE o.deliverer_id = $1 AND o.status IN ('accepted', 'picked_up', 'on_the_way')
     ORDER BY o.created_at DESC`,
    [userId]
  );

  res.json({
    asCustomer: customerOrders.map((o: any) => ({
      ...o,
      delivererRating: parseFloat(o.delivererRating) || 0,
      isDeliverer: false,
    })),
    asDeliverer: delivererOrders.map((o: any) => ({
      ...o,
      isDeliverer: true,
    })),
  });
}));

// Estimate delivery time based on locations
router.post('/estimate', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { pickupLat, pickupLng, deliveryLat, deliveryLng } = req.body;

  if (!pickupLat || !pickupLng || !deliveryLat || !deliveryLng) {
    res.status(400).json({ error: 'All coordinates are required' });
    return;
  }

  // Simple distance calculation (Haversine formula)
  const R = 3959; // Earth radius in miles
  const dLat = (deliveryLat - pickupLat) * Math.PI / 180;
  const dLng = (deliveryLng - pickupLng) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(pickupLat * Math.PI / 180) * Math.cos(deliveryLat * Math.PI / 180) *
            Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  const distance = R * c;

  // Estimate time (assume ~10 mph average on campus with stops)
  const estimatedMinutes = Math.max(5, Math.round(distance * 6 + 3));

  res.json({
    distanceMiles: Math.round(distance * 100) / 100,
    estimatedMinutes,
    estimatedFee: Math.max(3, Math.min(15, Math.round(3 + distance * 2))),
  });
}));

export default router;
