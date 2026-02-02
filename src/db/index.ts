import { Pool } from 'pg';
import { logger } from '../utils/logger';

// Create connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Pool error handler
pool.on('error', (err) => {
  logger.error('Unexpected error on idle database client', err);
});

// Query helper with logging
export async function query<T = any>(text: string, params?: any[]): Promise<T[]> {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    
    if (duration > 1000) {
      logger.warn(`Slow query (${duration}ms): ${text.substring(0, 100)}...`);
    }
    
    return result.rows;
  } catch (error) {
    logger.error('Database query error:', { text: text.substring(0, 100), error });
    throw error;
  }
}

// Get single row
export async function queryOne<T = any>(text: string, params?: any[]): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] || null;
}

// Transaction helper
export async function transaction<T>(
  callback: (client: any) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Initialize database with schema
export async function initializeDatabase(): Promise<void> {
  const schema = `
    -- Enable UUID extension
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

    -- Users table
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      name VARCHAR(100) NOT NULL,
      phone VARCHAR(20),
      is_verified BOOLEAN DEFAULT FALSE,
      verification_token VARCHAR(255),
      verification_expires TIMESTAMP,
      is_deliverer BOOLEAN DEFAULT FALSE,
      deliverer_vehicle VARCHAR(50),
      profile_image_url TEXT,
      avg_rating DECIMAL(3, 2) DEFAULT 0,
      total_ratings INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Orders table
    CREATE TABLE IF NOT EXISTS orders (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      customer_id UUID REFERENCES users(id) ON DELETE CASCADE,
      deliverer_id UUID REFERENCES users(id) ON DELETE SET NULL,
      status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'picked_up', 'on_the_way', 'delivered', 'cancelled')),
      pickup_location VARCHAR(255) NOT NULL,
      delivery_building VARCHAR(255) NOT NULL,
      delivery_room VARCHAR(50),
      special_instructions TEXT,
      order_image_url TEXT,
      estimated_pickup_time TIMESTAMP,
      estimated_delivery_time TIMESTAMP,
      actual_delivery_time TIMESTAMP,
      delivery_fee DECIMAL(10, 2) DEFAULT 0,
      tip DECIMAL(10, 2) DEFAULT 0,
      cancelled_reason TEXT,
      cancelled_by UUID REFERENCES users(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Deliveries table (for deliverer stats and tracking)
    CREATE TABLE IF NOT EXISTS deliveries (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
      deliverer_id UUID REFERENCES users(id) ON DELETE CASCADE,
      accepted_at TIMESTAMP,
      picked_up_at TIMESTAMP,
      delivered_at TIMESTAMP,
      distance_miles DECIMAL(5, 2),
      earnings DECIMAL(10, 2),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Ratings table
    CREATE TABLE IF NOT EXISTS ratings (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
      rater_id UUID REFERENCES users(id) ON DELETE CASCADE,
      rated_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      rating INTEGER CHECK (rating >= 1 AND rating <= 5),
      comment TEXT,
      rating_type VARCHAR(20) CHECK (rating_type IN ('customer_to_deliverer', 'deliverer_to_customer')),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(order_id, rater_id, rated_user_id)
    );

    -- Location tracking table (for real-time updates)
    CREATE TABLE IF NOT EXISTS location_updates (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      latitude DECIMAL(10, 8) NOT NULL,
      longitude DECIMAL(11, 8) NOT NULL,
      accuracy DECIMAL(10, 2),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Push notification tokens
    CREATE TABLE IF NOT EXISTS push_tokens (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL,
      platform VARCHAR(20) CHECK (platform IN ('ios', 'android', 'web')),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, token)
    );

    -- Campus Rides table
    CREATE TABLE IF NOT EXISTS rides (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      rider_id UUID REFERENCES users(id) ON DELETE CASCADE,
      driver_id UUID REFERENCES users(id) ON DELETE SET NULL,
      status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'arriving', 'in_progress', 'completed', 'cancelled')),
      pickup_location VARCHAR(255) NOT NULL,
      pickup_latitude DECIMAL(10, 8),
      pickup_longitude DECIMAL(11, 8),
      dropoff_location VARCHAR(255) NOT NULL,
      dropoff_latitude DECIMAL(10, 8),
      dropoff_longitude DECIMAL(11, 8),
      num_passengers INTEGER DEFAULT 1 CHECK (num_passengers >= 1 AND num_passengers <= 4),
      special_instructions TEXT,
      estimated_duration_minutes INTEGER,
      actual_duration_minutes INTEGER,
      ride_fee DECIMAL(10, 2) DEFAULT 0,
      tip DECIMAL(10, 2) DEFAULT 0,
      cancelled_reason TEXT,
      cancelled_by UUID REFERENCES users(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      accepted_at TIMESTAMP,
      started_at TIMESTAMP,
      completed_at TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- User stats table (cached stats for performance)
    CREATE TABLE IF NOT EXISTS user_stats (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      total_orders INTEGER DEFAULT 0,
      total_deliveries INTEGER DEFAULT 0,
      total_rides_requested INTEGER DEFAULT 0,
      total_rides_given INTEGER DEFAULT 0,
      total_earnings DECIMAL(10, 2) DEFAULT 0,
      total_tips DECIMAL(10, 2) DEFAULT 0,
      avg_delivery_time_minutes INTEGER,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Indexes for performance
    CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id);
    CREATE INDEX IF NOT EXISTS idx_orders_deliverer_id ON orders(deliverer_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_deliveries_deliverer_id ON deliveries(deliverer_id);
    CREATE INDEX IF NOT EXISTS idx_location_updates_order_id ON location_updates(order_id);
    CREATE INDEX IF NOT EXISTS idx_ratings_rated_user_id ON ratings(rated_user_id);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_rides_rider_id ON rides(rider_id);
    CREATE INDEX IF NOT EXISTS idx_rides_driver_id ON rides(driver_id);
    CREATE INDEX IF NOT EXISTS idx_rides_status ON rides(status);
    CREATE INDEX IF NOT EXISTS idx_rides_created_at ON rides(created_at DESC);

    -- Update timestamp trigger
    CREATE OR REPLACE FUNCTION update_updated_at_column()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = CURRENT_TIMESTAMP;
      RETURN NEW;
    END;
    $$ language 'plpgsql';

    -- Apply trigger to tables
    DROP TRIGGER IF EXISTS update_users_updated_at ON users;
    CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

    DROP TRIGGER IF EXISTS update_orders_updated_at ON orders;
    CREATE TRIGGER update_orders_updated_at BEFORE UPDATE ON orders
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  `;

  try {
    await pool.query(schema);
    logger.info('Database schema initialized');
  } catch (error) {
    logger.error('Failed to initialize database schema:', error);
    throw error;
  }
}

export { pool };
