# KnightDeliver Backend API

Express.js backend for the KnightDeliver UCF campus delivery app.

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env
# Edit .env with your database URL and secrets

# Run development server
npm run dev

# Build for production
npm run build

# Run production server
npm start
```

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user (requires UCF email)
- `POST /api/auth/login` - Login with email/password
- `POST /api/auth/verify-email` - Verify email with code
- `POST /api/auth/resend-verification` - Resend verification code
- `GET /api/auth/me` - Get current user
- `PUT /api/auth/change-password` - Change password
- `POST /api/auth/logout` - Logout

### Users
- `GET /api/users/:userId` - Get user profile (public info)
- `PUT /api/users/profile` - Update profile
- `POST /api/users/become-deliverer` - Become a deliverer
- `PUT /api/users/deliverer/vehicle` - Update vehicle
- `GET /api/users/stats/me` - Get my stats
- `POST /api/users/push-token` - Register push token
- `DELETE /api/users/push-token` - Remove push token

### Orders
- `POST /api/orders` - Create new order
- `GET /api/orders/my-orders` - Get my orders
- `GET /api/orders/:orderId` - Get order details
- `PUT /api/orders/:orderId/status` - Update order status
- `DELETE /api/orders/:orderId` - Cancel order
- `POST /api/orders/:orderId/tip` - Add tip

### Deliveries
- `GET /api/deliveries/available` - Get available orders
- `POST /api/deliveries/:orderId/accept` - Accept order
- `POST /api/deliveries/:orderId/pickup` - Mark picked up
- `POST /api/deliveries/:orderId/on-the-way` - Mark on the way
- `POST /api/deliveries/:orderId/complete` - Complete delivery
- `GET /api/deliveries/active` - Get active delivery
- `GET /api/deliveries/my-deliveries` - Get delivery history
- `GET /api/deliveries/earnings` - Get earnings summary

### Tracking
- `POST /api/tracking/location` - Update location
- `GET /api/tracking/order/:orderId/location` - Get latest location
- `GET /api/tracking/order/:orderId/history` - Get location history
- `GET /api/tracking/active` - Get active tracked orders
- `POST /api/tracking/estimate` - Estimate delivery time

### Ratings
- `POST /api/ratings/order/:orderId` - Rate an order
- `GET /api/ratings/user/:userId` - Get user ratings
- `GET /api/ratings/my-ratings` - Get ratings I've given
- `GET /api/ratings/pending/:orderId` - Check if order needs rating

## WebSocket Events

### Client Events
- `subscribe_order` - Subscribe to order updates
- `unsubscribe_order` - Unsubscribe from order
- `location_update` - Send location update (deliverers)
- `go_online` - Go online as deliverer
- `go_offline` - Go offline as deliverer

### Server Events
- `location_update` - Location update broadcast
- `order_status_update` - Status change
- `order_accepted` - Order accepted by deliverer
- `order_picked_up` - Order picked up
- `order_on_the_way` - Deliverer on the way
- `order_delivered` - Order delivered
- `order_cancelled` - Order cancelled
- `new_order` - New order available (to deliverers)

## Database Schema

Tables:
- `users` - User accounts
- `orders` - Delivery orders
- `deliveries` - Delivery records
- `ratings` - Order ratings
- `location_updates` - GPS tracking data
- `push_tokens` - Push notification tokens
- `user_stats` - Cached user statistics

## Deployment

### Railway (Recommended)
1. Connect GitHub repo
2. Add environment variables
3. Deploy! Auto-detects `railway.toml`

### Docker
```bash
docker build -t knightdeliver-api .
docker run -p 3000:3000 --env-file .env knightdeliver-api
```

## UCF Email Validation

Only `@ucf.edu` and `@knights.ucf.edu` emails are accepted for registration.

---

Built for UCF students 🤴⚡
