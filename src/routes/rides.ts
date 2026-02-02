import { Router, Response } from 'express';
import { query, queryOne, transaction } from '../db';
import { authenticate, requireVerified, requireDeliverer, AuthRequest } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { validate, paginationValidation } from '../middleware/validation';
import { body, param } from 'express-validator';
import { logger } from '../utils/logger';

const router = Router();

// Validation for ride creation
const createRideValidation = [
  body('pickupLocation')
    .trim()
    .isLength({ min: 3, max: 255 })
    .withMessage('Pickup location is required'),
  body('dropoffLocation')
    .trim()
    .isLength({ min: 3, max: 255 })
    .withMessage('Dropoff location is required'),
  body('pickupLatitude').optional().isFloat({ min: -90, max: 90 }),
  body('pickupLongitude').optional().isFloat({ min: -180, max: 180 }),
  body('dropoffLatitude').optional().isFloat({ min: -90, max: 90 }),
  body('dropoffLongitude').optional().isFloat({ min: -180, max: 180 }),
  body('numPassengers').optional().isInt({ min: 1, max: 4 }),
  body('specialInstructions').optional().trim().isLength({ max: 500 }),
];

// Request a ride
router.post('/', authenticate, requireVerified, validate(createRideValidation), asyncHandler(async (req: AuthRequest, res: Response) => {
  const riderId = req.user!.id;
  const {
    pickupLocation,
    dropoffLocation,
    pickupLatitude,
    pickupLongitude,
    dropoffLatitude,
    dropoffLongitude,
    numPassengers = 1,
    specialInstructions,
  } = req.body;

  // Check for existing active ride
  const existingRide = await queryOne(
    `SELECT id FROM rides WHERE rider_id = $1 AND status IN ('pending', 'accepted', 'arriving', 'in_progress')`,
    [riderId]
  );

  if (existingRide) {
    res.status(400).json({
      error: 'You already have an active ride request',
      activeRideId: existingRide.id,
    });
    return;
  }

  // Calculate estimated duration (simple estimate based on campus distances)
  const estimatedDuration = 5 + Math.floor(Math.random() * 10); // 5-15 minutes

  const [ride] = await query(
    `INSERT INTO rides (rider_id, pickup_location, dropoff_location, pickup_latitude, pickup_longitude, 
     dropoff_latitude, dropoff_longitude, num_passengers, special_instructions, estimated_duration_minutes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [riderId, pickupLocation, dropoffLocation, pickupLatitude, pickupLongitude,
     dropoffLatitude, dropoffLongitude, numPassengers, specialInstructions, estimatedDuration]
  );

  // Update user stats
  await query(
    `UPDATE user_stats SET total_rides_requested = total_rides_requested + 1 WHERE user_id = $1`,
    [riderId]
  );

  // Emit socket event for new ride
  const io = req.app.get('io');
  io.to('drivers').emit('new_ride', {
    rideId: ride.id,
    pickupLocation,
    dropoffLocation,
    numPassengers,
    estimatedDuration,
    createdAt: ride.created_at,
  });

  logger.info(`New ride requested: ${ride.id} by ${riderId}`);

  res.status(201).json({
    message: 'Ride requested successfully',
    ride: {
      id: ride.id,
      status: ride.status,
      pickupLocation: ride.pickup_location,
      dropoffLocation: ride.dropoff_location,
      numPassengers: ride.num_passengers,
      estimatedDuration: ride.estimated_duration_minutes,
      createdAt: ride.created_at,
    },
  });
}));

// Get available ride requests (for drivers)
router.get('/available', authenticate, requireDeliverer, asyncHandler(async (req: AuthRequest, res: Response) => {
  const driverId = req.user!.id;

  const rides = await query(
    `SELECT r.id, r.pickup_location as "pickupLocation", r.dropoff_location as "dropoffLocation",
            r.pickup_latitude as "pickupLatitude", r.pickup_longitude as "pickupLongitude",
            r.dropoff_latitude as "dropoffLatitude", r.dropoff_longitude as "dropoffLongitude",
            r.num_passengers as "numPassengers", r.special_instructions as "specialInstructions",
            r.estimated_duration_minutes as "estimatedDuration", r.ride_fee as "rideFee",
            r.created_at as "createdAt",
            u.name as "riderName", u.avg_rating as "riderRating"
     FROM rides r
     JOIN users u ON r.rider_id = u.id
     WHERE r.status = 'pending'
     AND r.rider_id != $1
     ORDER BY r.created_at ASC
     LIMIT 20`,
    [driverId]
  );

  // Add urgency based on wait time
  const ridesWithUrgency = rides.map((ride: any) => {
    const waitMinutes = (Date.now() - new Date(ride.createdAt).getTime()) / 60000;
    let urgency: 'low' | 'medium' | 'high' = 'low';
    if (waitMinutes > 10) urgency = 'high';
    else if (waitMinutes > 5) urgency = 'medium';

    return {
      ...ride,
      estimatedEarnings: parseFloat(ride.rideFee) || 3 + Math.random() * 4,
      urgency,
    };
  });

  res.json({ rides: ridesWithUrgency });
}));

// Accept a ride
router.post('/:rideId/accept', authenticate, requireDeliverer, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { rideId } = req.params;
  const driverId = req.user!.id;

  // Check if driver has an active ride
  const activeRide = await queryOne(
    `SELECT id FROM rides WHERE driver_id = $1 AND status IN ('accepted', 'arriving', 'in_progress')`,
    [driverId]
  );

  if (activeRide) {
    res.status(400).json({
      error: 'You already have an active ride',
      activeRideId: activeRide.id,
    });
    return;
  }

  const result = await transaction(async (client) => {
    const ride = await client.query(
      `SELECT * FROM rides WHERE id = $1 AND status = 'pending' FOR UPDATE`,
      [rideId]
    );

    if (ride.rows.length === 0) {
      throw new Error('Ride is no longer available');
    }

    const rideData = ride.rows[0];

    await client.query(
      `UPDATE rides SET driver_id = $1, status = 'accepted', accepted_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [driverId, rideId]
    );

    return rideData;
  });

  // Get rider info
  const rider = await queryOne(
    `SELECT id, name, phone FROM users WHERE id = $1`,
    [result.rider_id]
  );

  // Emit socket events
  const io = req.app.get('io');
  io.to(`ride:${rideId}`).emit('ride_accepted', {
    rideId,
    driverId,
    driverName: req.user!.name,
  });
  io.to('drivers').emit('ride_taken', { rideId });

  logger.info(`Ride ${rideId} accepted by driver ${driverId}`);

  res.json({
    message: 'Ride accepted! Head to the pickup location.',
    ride: {
      id: rideId,
      status: 'accepted',
      pickupLocation: result.pickup_location,
      dropoffLocation: result.dropoff_location,
      numPassengers: result.num_passengers,
      specialInstructions: result.special_instructions,
      rider: {
        name: rider?.name,
        phone: rider?.phone,
      },
    },
  });
}));

// Mark as arriving
router.post('/:rideId/arriving', authenticate, requireDeliverer, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { rideId } = req.params;
  const driverId = req.user!.id;

  const ride = await queryOne(
    'SELECT * FROM rides WHERE id = $1 AND driver_id = $2',
    [rideId, driverId]
  );

  if (!ride) {
    res.status(404).json({ error: 'Ride not found or not assigned to you' });
    return;
  }

  if (ride.status !== 'accepted') {
    res.status(400).json({ error: 'Ride must be in accepted status' });
    return;
  }

  await query(`UPDATE rides SET status = 'arriving' WHERE id = $1`, [rideId]);

  const io = req.app.get('io');
  io.to(`ride:${rideId}`).emit('driver_arriving', {
    rideId,
    timestamp: new Date().toISOString(),
  });

  res.json({
    message: 'Rider has been notified you are arriving!',
    ride: { id: rideId, status: 'arriving' },
  });
}));

// Start ride
router.post('/:rideId/start', authenticate, requireDeliverer, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { rideId } = req.params;
  const driverId = req.user!.id;

  const ride = await queryOne(
    'SELECT * FROM rides WHERE id = $1 AND driver_id = $2',
    [rideId, driverId]
  );

  if (!ride) {
    res.status(404).json({ error: 'Ride not found or not assigned to you' });
    return;
  }

  if (!['accepted', 'arriving'].includes(ride.status)) {
    res.status(400).json({ error: 'Cannot start ride from current status' });
    return;
  }

  await query(
    `UPDATE rides SET status = 'in_progress', started_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [rideId]
  );

  const io = req.app.get('io');
  io.to(`ride:${rideId}`).emit('ride_started', {
    rideId,
    timestamp: new Date().toISOString(),
  });

  res.json({
    message: 'Ride started!',
    ride: { id: rideId, status: 'in_progress' },
  });
}));

// Complete ride
router.post('/:rideId/complete', authenticate, requireDeliverer, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { rideId } = req.params;
  const driverId = req.user!.id;

  const ride = await queryOne(
    'SELECT * FROM rides WHERE id = $1 AND driver_id = $2',
    [rideId, driverId]
  );

  if (!ride) {
    res.status(404).json({ error: 'Ride not found or not assigned to you' });
    return;
  }

  if (ride.status !== 'in_progress') {
    res.status(400).json({ error: 'Ride must be in progress to complete' });
    return;
  }

  const rideFee = parseFloat(ride.ride_fee) || 3;
  const actualDuration = ride.started_at
    ? Math.round((Date.now() - new Date(ride.started_at).getTime()) / 60000)
    : ride.estimated_duration_minutes;

  await transaction(async (client) => {
    await client.query(
      `UPDATE rides SET status = 'completed', completed_at = CURRENT_TIMESTAMP, 
       actual_duration_minutes = $1 WHERE id = $2`,
      [actualDuration, rideId]
    );

    await client.query(
      `UPDATE user_stats SET total_rides_given = total_rides_given + 1,
       total_earnings = total_earnings + $1 WHERE user_id = $2`,
      [rideFee, driverId]
    );
  });

  const io = req.app.get('io');
  io.to(`ride:${rideId}`).emit('ride_completed', {
    rideId,
    timestamp: new Date().toISOString(),
  });

  logger.info(`Ride ${rideId} completed by ${driverId}`);

  res.json({
    message: 'Ride completed! 🎉',
    ride: { id: rideId, status: 'completed' },
    earnings: rideFee,
    actualDuration,
  });
}));

// Cancel ride
router.delete('/:rideId', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { rideId } = req.params;
  const { reason } = req.body;
  const userId = req.user!.id;

  const ride = await queryOne('SELECT * FROM rides WHERE id = $1', [rideId]);

  if (!ride) {
    res.status(404).json({ error: 'Ride not found' });
    return;
  }

  if (ride.rider_id !== userId && ride.driver_id !== userId) {
    res.status(403).json({ error: 'Not authorized to cancel this ride' });
    return;
  }

  if (['completed', 'cancelled'].includes(ride.status)) {
    res.status(400).json({ error: 'Cannot cancel completed or already cancelled ride' });
    return;
  }

  await query(
    `UPDATE rides SET status = 'cancelled', cancelled_reason = $1, cancelled_by = $2 WHERE id = $3`,
    [reason || 'No reason provided', userId, rideId]
  );

  const io = req.app.get('io');
  io.to(`ride:${rideId}`).emit('ride_cancelled', {
    rideId,
    cancelledBy: userId,
    reason: reason || 'No reason provided',
  });

  res.json({ message: 'Ride cancelled' });
}));

// Get my rides (as rider)
router.get('/my-rides', authenticate, validate(paginationValidation), asyncHandler(async (req: AuthRequest, res: Response) => {
  const riderId = req.user!.id;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const offset = (page - 1) * limit;

  const rides = await query(
    `SELECT r.id, r.status, r.pickup_location as "pickupLocation", r.dropoff_location as "dropoffLocation",
            r.num_passengers as "numPassengers", r.ride_fee as "rideFee", r.tip,
            r.estimated_duration_minutes as "estimatedDuration", r.actual_duration_minutes as "actualDuration",
            r.created_at as "createdAt", r.completed_at as "completedAt",
            u.id as "driverId", u.name as "driverName", u.deliverer_vehicle as "driverVehicle",
            u.avg_rating as "driverRating"
     FROM rides r
     LEFT JOIN users u ON r.driver_id = u.id
     WHERE r.rider_id = $1
     ORDER BY r.created_at DESC
     LIMIT $2 OFFSET $3`,
    [riderId, limit, offset]
  );

  const [{ count }] = await query(
    'SELECT COUNT(*) as count FROM rides WHERE rider_id = $1',
    [riderId]
  );

  res.json({
    rides,
    pagination: {
      page,
      limit,
      total: parseInt(count),
      totalPages: Math.ceil(parseInt(count) / limit),
    },
  });
}));

// Get ride details
router.get('/:rideId', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { rideId } = req.params;
  const userId = req.user!.id;

  const ride = await queryOne(
    `SELECT r.*, 
            rider.name as "riderName", rider.phone as "riderPhone",
            driver.name as "driverName", driver.phone as "driverPhone",
            driver.deliverer_vehicle as "driverVehicle", driver.avg_rating as "driverRating"
     FROM rides r
     JOIN users rider ON r.rider_id = rider.id
     LEFT JOIN users driver ON r.driver_id = driver.id
     WHERE r.id = $1`,
    [rideId]
  );

  if (!ride) {
    res.status(404).json({ error: 'Ride not found' });
    return;
  }

  if (ride.rider_id !== userId && ride.driver_id !== userId) {
    res.status(403).json({ error: 'Not authorized to view this ride' });
    return;
  }

  res.json({
    ride: {
      id: ride.id,
      status: ride.status,
      pickupLocation: ride.pickup_location,
      dropoffLocation: ride.dropoff_location,
      numPassengers: ride.num_passengers,
      specialInstructions: ride.special_instructions,
      estimatedDuration: ride.estimated_duration_minutes,
      actualDuration: ride.actual_duration_minutes,
      rideFee: parseFloat(ride.ride_fee) || 0,
      tip: parseFloat(ride.tip) || 0,
      createdAt: ride.created_at,
      completedAt: ride.completed_at,
      rider: {
        id: ride.rider_id,
        name: ride.riderName,
        phone: ride.rider_id === userId ? ride.riderPhone : null,
      },
      driver: ride.driver_id ? {
        id: ride.driver_id,
        name: ride.driverName,
        phone: ride.driver_id === userId || ride.rider_id === userId ? ride.driverPhone : null,
        vehicle: ride.driverVehicle,
        rating: parseFloat(ride.driverRating) || 0,
      } : null,
    },
  });
}));

// Active ride for driver
router.get('/driver/active', authenticate, requireDeliverer, asyncHandler(async (req: AuthRequest, res: Response) => {
  const driverId = req.user!.id;

  const ride = await queryOne(
    `SELECT r.*, u.name as "riderName", u.phone as "riderPhone"
     FROM rides r
     JOIN users u ON r.rider_id = u.id
     WHERE r.driver_id = $1 AND r.status IN ('accepted', 'arriving', 'in_progress')`,
    [driverId]
  );

  if (!ride) {
    res.json({ activeRide: null });
    return;
  }

  res.json({
    activeRide: {
      id: ride.id,
      status: ride.status,
      pickupLocation: ride.pickup_location,
      dropoffLocation: ride.dropoff_location,
      numPassengers: ride.num_passengers,
      specialInstructions: ride.special_instructions,
      rider: {
        name: ride.riderName,
        phone: ride.riderPhone,
      },
    },
  });
}));

export default router;
