import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { queryOne } from '../db';
import { logger } from '../utils/logger';

interface AuthenticatedSocket extends Socket {
  userId?: string;
  userName?: string;
  isDeliverer?: boolean;
}

export function setupSocketHandlers(io: Server) {
  // Authentication middleware
  io.use(async (socket: AuthenticatedSocket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.split(' ')[1];
      
      if (!token) {
        // Allow anonymous connections for limited functionality
        next();
        return;
      }

      const secret = process.env.JWT_SECRET || 'default-secret';
      const decoded = jwt.verify(token, secret) as { userId: string };

      const user = await queryOne(
        'SELECT id, name, is_deliverer FROM users WHERE id = $1',
        [decoded.userId]
      );

      if (user) {
        socket.userId = user.id;
        socket.userName = user.name;
        socket.isDeliverer = user.is_deliverer;
      }

      next();
    } catch (error) {
      logger.warn('Socket authentication failed:', error);
      next(); // Allow connection but without auth
    }
  });

  io.on('connection', (socket: AuthenticatedSocket) => {
    logger.info(`Socket connected: ${socket.id} (user: ${socket.userId || 'anonymous'})`);

    // Join user's personal room
    if (socket.userId) {
      socket.join(`user:${socket.userId}`);

      // Join deliverers room if user is a deliverer
      if (socket.isDeliverer) {
        socket.join('deliverers');
        logger.info(`User ${socket.userId} joined deliverers room`);
      }
    }

    // Subscribe to order updates
    socket.on('subscribe_order', async (orderId: string) => {
      if (!orderId) return;

      // Verify user has access to this order
      if (socket.userId) {
        const order = await queryOne(
          'SELECT id FROM orders WHERE id = $1 AND (customer_id = $2 OR deliverer_id = $2)',
          [orderId, socket.userId]
        );

        if (order) {
          socket.join(`order:${orderId}`);
          logger.info(`User ${socket.userId} subscribed to order ${orderId}`);
          socket.emit('subscribed', { orderId });
        } else {
          socket.emit('error', { message: 'Not authorized to view this order' });
        }
      }
    });

    // Unsubscribe from order updates
    socket.on('unsubscribe_order', (orderId: string) => {
      socket.leave(`order:${orderId}`);
      logger.info(`Socket ${socket.id} unsubscribed from order ${orderId}`);
    });

    // Handle location updates from deliverers
    socket.on('location_update', async (data: { orderId: string; latitude: number; longitude: number; accuracy?: number }) => {
      if (!socket.userId || !socket.isDeliverer) {
        socket.emit('error', { message: 'Not authorized' });
        return;
      }

      const { orderId, latitude, longitude, accuracy } = data;

      // Validate data
      if (!orderId || typeof latitude !== 'number' || typeof longitude !== 'number') {
        socket.emit('error', { message: 'Invalid location data' });
        return;
      }

      // Verify deliverer is assigned to this order
      const order = await queryOne(
        `SELECT id FROM orders WHERE id = $1 AND deliverer_id = $2 AND status IN ('accepted', 'picked_up', 'on_the_way')`,
        [orderId, socket.userId]
      );

      if (!order) {
        socket.emit('error', { message: 'Not assigned to this order' });
        return;
      }

      // Broadcast location to order room
      io.to(`order:${orderId}`).emit('deliverer_location', {
        orderId,
        latitude,
        longitude,
        accuracy,
        timestamp: new Date().toISOString(),
      });
    });

    // Handle order status updates
    socket.on('update_status', async (data: { orderId: string; status: string }) => {
      if (!socket.userId) {
        socket.emit('error', { message: 'Not authenticated' });
        return;
      }

      // This is a notification to other clients - the actual update happens via REST API
      io.to(`order:${data.orderId}`).emit('status_updated', {
        orderId: data.orderId,
        status: data.status,
        updatedBy: socket.userId,
        timestamp: new Date().toISOString(),
      });
    });

    // Handle typing indicators for chat (future feature)
    socket.on('typing_start', (orderId: string) => {
      socket.to(`order:${orderId}`).emit('user_typing', {
        userId: socket.userId,
        userName: socket.userName,
      });
    });

    socket.on('typing_stop', (orderId: string) => {
      socket.to(`order:${orderId}`).emit('user_stopped_typing', {
        userId: socket.userId,
      });
    });

    // Go online/offline as deliverer/driver
    socket.on('go_online', () => {
      if (socket.userId && socket.isDeliverer) {
        socket.join('deliverers');
        socket.join('drivers'); // Also join drivers room for rides
        io.to('deliverers').emit('deliverer_online', {
          userId: socket.userId,
          userName: socket.userName,
        });
        logger.info(`Deliverer/Driver ${socket.userId} went online`);
      }
    });

    socket.on('go_offline', () => {
      if (socket.userId && socket.isDeliverer) {
        socket.leave('deliverers');
        socket.leave('drivers');
        io.to('deliverers').emit('deliverer_offline', {
          userId: socket.userId,
        });
        logger.info(`Deliverer/Driver ${socket.userId} went offline`);
      }
    });

    // Subscribe to ride updates
    socket.on('subscribe_ride', async (rideId: string) => {
      if (!rideId) return;

      if (socket.userId) {
        const ride = await queryOne(
          'SELECT id FROM rides WHERE id = $1 AND (rider_id = $2 OR driver_id = $2)',
          [rideId, socket.userId]
        );

        if (ride) {
          socket.join(`ride:${rideId}`);
          logger.info(`User ${socket.userId} subscribed to ride ${rideId}`);
          socket.emit('subscribed_ride', { rideId });
        } else {
          socket.emit('error', { message: 'Not authorized to view this ride' });
        }
      }
    });

    // Unsubscribe from ride updates
    socket.on('unsubscribe_ride', (rideId: string) => {
      socket.leave(`ride:${rideId}`);
      logger.info(`Socket ${socket.id} unsubscribed from ride ${rideId}`);
    });

    // Handle disconnection
    socket.on('disconnect', (reason) => {
      logger.info(`Socket disconnected: ${socket.id} (reason: ${reason})`);
    });

    // Handle errors
    socket.on('error', (error) => {
      logger.error(`Socket error for ${socket.id}:`, error);
    });
  });

  // Periodic cleanup of stale connections (optional)
  setInterval(() => {
    const sockets = io.sockets.sockets;
    logger.debug(`Active sockets: ${sockets.size}`);
  }, 60000);

  logger.info('Socket.io handlers initialized');
}

// Helper to emit to specific user
export function emitToUser(io: Server, userId: string, event: string, data: any) {
  io.to(`user:${userId}`).emit(event, data);
}

// Helper to emit to order subscribers
export function emitToOrder(io: Server, orderId: string, event: string, data: any) {
  io.to(`order:${orderId}`).emit(event, data);
}

// Helper to emit to all deliverers
export function emitToDeliverers(io: Server, event: string, data: any) {
  io.to('deliverers').emit(event, data);
}
