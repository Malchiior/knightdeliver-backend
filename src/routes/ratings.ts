import { Router, Response } from 'express';
import { query, queryOne, transaction } from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { validate, createRatingValidation } from '../middleware/validation';
import { logger } from '../utils/logger';

const router = Router();

// Create rating for an order
router.post('/order/:orderId', authenticate, validate(createRatingValidation), asyncHandler(async (req: AuthRequest, res: Response) => {
  const { orderId } = req.params;
  const { rating, comment } = req.body;
  const raterId = req.user!.id;

  // Get the order
  const order = await queryOne(
    'SELECT * FROM orders WHERE id = $1',
    [orderId]
  );

  if (!order) {
    res.status(404).json({ error: 'Order not found' });
    return;
  }

  if (order.status !== 'delivered') {
    res.status(400).json({ error: 'Can only rate delivered orders' });
    return;
  }

  // Determine who is being rated
  let ratedUserId: string;
  let ratingType: string;

  if (order.customer_id === raterId) {
    // Customer rating the deliverer
    if (!order.deliverer_id) {
      res.status(400).json({ error: 'Order has no deliverer to rate' });
      return;
    }
    ratedUserId = order.deliverer_id;
    ratingType = 'customer_to_deliverer';
  } else if (order.deliverer_id === raterId) {
    // Deliverer rating the customer
    ratedUserId = order.customer_id;
    ratingType = 'deliverer_to_customer';
  } else {
    res.status(403).json({ error: 'Not authorized to rate this order' });
    return;
  }

  // Check if already rated
  const existingRating = await queryOne(
    `SELECT id FROM ratings WHERE order_id = $1 AND rater_id = $2 AND rated_user_id = $3`,
    [orderId, raterId, ratedUserId]
  );

  if (existingRating) {
    res.status(400).json({ error: 'You have already rated this order' });
    return;
  }

  // Create rating and update user average
  await transaction(async (client) => {
    // Insert rating
    await client.query(
      `INSERT INTO ratings (order_id, rater_id, rated_user_id, rating, comment, rating_type)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [orderId, raterId, ratedUserId, rating, comment, ratingType]
    );

    // Update user's average rating
    const ratingStats = await client.query(
      `SELECT AVG(rating) as avg, COUNT(*) as count 
       FROM ratings WHERE rated_user_id = $1`,
      [ratedUserId]
    );

    await client.query(
      `UPDATE users SET avg_rating = $1, total_ratings = $2 WHERE id = $3`,
      [ratingStats.rows[0].avg, ratingStats.rows[0].count, ratedUserId]
    );
  });

  logger.info(`Rating created: ${rating} stars for user ${ratedUserId} by ${raterId}`);

  res.status(201).json({
    message: 'Rating submitted successfully',
    rating: {
      orderId,
      rating,
      comment,
      ratingType,
    },
  });
}));

// Get ratings for a user
router.get('/user/:userId', asyncHandler(async (req: AuthRequest, res: Response) => {
  const { userId } = req.params;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 10;
  const offset = (page - 1) * limit;

  // Get user's rating summary
  const user = await queryOne(
    `SELECT avg_rating as "avgRating", total_ratings as "totalRatings"
     FROM users WHERE id = $1`,
    [userId]
  );

  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  // Get rating breakdown
  const breakdown = await query(
    `SELECT rating, COUNT(*) as count
     FROM ratings WHERE rated_user_id = $1
     GROUP BY rating ORDER BY rating DESC`,
    [userId]
  );

  // Get recent ratings with comments
  const ratings = await query(
    `SELECT r.rating, r.comment, r.rating_type as "ratingType", r.created_at as "createdAt",
            u.name as "raterName"
     FROM ratings r
     JOIN users u ON r.rater_id = u.id
     WHERE r.rated_user_id = $1
     ORDER BY r.created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );

  res.json({
    summary: {
      avgRating: parseFloat(user.avgRating) || 0,
      totalRatings: user.totalRatings || 0,
      breakdown: breakdown.reduce((acc: any, b: any) => {
        acc[b.rating] = parseInt(b.count);
        return acc;
      }, { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }),
    },
    ratings,
    pagination: {
      page,
      limit,
    },
  });
}));

// Get ratings I've given
router.get('/my-ratings', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;

  const ratings = await query(
    `SELECT r.rating, r.comment, r.rating_type as "ratingType", r.created_at as "createdAt",
            r.order_id as "orderId",
            u.name as "ratedUserName"
     FROM ratings r
     JOIN users u ON r.rated_user_id = u.id
     WHERE r.rater_id = $1
     ORDER BY r.created_at DESC
     LIMIT 50`,
    [userId]
  );

  res.json({ ratings });
}));

// Check if order needs rating
router.get('/pending/:orderId', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { orderId } = req.params;
  const userId = req.user!.id;

  const order = await queryOne(
    'SELECT customer_id, deliverer_id, status FROM orders WHERE id = $1',
    [orderId]
  );

  if (!order) {
    res.status(404).json({ error: 'Order not found' });
    return;
  }

  if (order.status !== 'delivered') {
    res.json({ needsRating: false, reason: 'Order not delivered' });
    return;
  }

  // Check if user has already rated
  let ratedUserId: string | null = null;
  if (order.customer_id === userId && order.deliverer_id) {
    ratedUserId = order.deliverer_id;
  } else if (order.deliverer_id === userId) {
    ratedUserId = order.customer_id;
  }

  if (!ratedUserId) {
    res.json({ needsRating: false, reason: 'Not part of this order' });
    return;
  }

  const existingRating = await queryOne(
    `SELECT id FROM ratings WHERE order_id = $1 AND rater_id = $2`,
    [orderId, userId]
  );

  res.json({
    needsRating: !existingRating,
    ratedUserId,
    isCustomer: order.customer_id === userId,
  });
}));

export default router;
