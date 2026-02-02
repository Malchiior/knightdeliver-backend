import { Request, Response, NextFunction } from 'express';
import { body, param, query, validationResult, ValidationChain } from 'express-validator';

// UCF email validation
export const isUCFEmail = (email: string): boolean => {
  return email.toLowerCase().endsWith('@ucf.edu') || 
         email.toLowerCase().endsWith('@knights.ucf.edu');
};

// Validation result handler
export const validate = (validations: ValidationChain[]) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Run all validations
    await Promise.all(validations.map(validation => validation.run(req)));

    const errors = validationResult(req);
    if (errors.isEmpty()) {
      next();
      return;
    }

    res.status(400).json({
      error: 'Validation failed',
      details: errors.array().map(err => ({
        field: (err as any).path || (err as any).param,
        message: err.msg,
      })),
    });
  };
};

// Auth validations
export const registerValidation = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Valid email is required')
    .custom((value) => {
      if (!isUCFEmail(value)) {
        throw new Error('Must use a UCF email address (@ucf.edu or @knights.ucf.edu)');
      }
      return true;
    }),
  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters')
    .matches(/[A-Z]/)
    .withMessage('Password must contain at least one uppercase letter')
    .matches(/[a-z]/)
    .withMessage('Password must contain at least one lowercase letter')
    .matches(/[0-9]/)
    .withMessage('Password must contain at least one number'),
  body('name')
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage('Name must be between 2 and 100 characters'),
  body('phone')
    .optional()
    .isMobilePhone('en-US')
    .withMessage('Invalid phone number'),
];

export const loginValidation = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Valid email is required'),
  body('password')
    .notEmpty()
    .withMessage('Password is required'),
];

// Order validations
export const createOrderValidation = [
  body('pickupLocation')
    .trim()
    .isLength({ min: 3, max: 255 })
    .withMessage('Pickup location is required (3-255 characters)'),
  body('deliveryBuilding')
    .trim()
    .isLength({ min: 3, max: 255 })
    .withMessage('Delivery building is required (3-255 characters)'),
  body('deliveryRoom')
    .optional()
    .trim()
    .isLength({ max: 50 })
    .withMessage('Room number must be 50 characters or less'),
  body('specialInstructions')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Special instructions must be 500 characters or less'),
  body('estimatedPickupTime')
    .optional()
    .isISO8601()
    .withMessage('Invalid date format'),
  body('orderImageUrl')
    .optional()
    .isURL()
    .withMessage('Invalid image URL'),
];

export const updateOrderStatusValidation = [
  param('orderId')
    .isUUID()
    .withMessage('Invalid order ID'),
  body('status')
    .isIn(['pending', 'accepted', 'picked_up', 'on_the_way', 'delivered', 'cancelled'])
    .withMessage('Invalid order status'),
  body('cancelledReason')
    .if(body('status').equals('cancelled'))
    .notEmpty()
    .withMessage('Cancellation reason is required'),
];

// Rating validations
export const createRatingValidation = [
  param('orderId')
    .isUUID()
    .withMessage('Invalid order ID'),
  body('rating')
    .isInt({ min: 1, max: 5 })
    .withMessage('Rating must be between 1 and 5'),
  body('comment')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Comment must be 500 characters or less'),
];

// Location validations
export const locationUpdateValidation = [
  body('orderId')
    .isUUID()
    .withMessage('Invalid order ID'),
  body('latitude')
    .isFloat({ min: -90, max: 90 })
    .withMessage('Invalid latitude'),
  body('longitude')
    .isFloat({ min: -180, max: 180 })
    .withMessage('Invalid longitude'),
  body('accuracy')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('Invalid accuracy'),
];

// Pagination validations
export const paginationValidation = [
  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Page must be a positive integer'),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('Limit must be between 1 and 100'),
];

// UUID param validation
export const uuidParamValidation = (paramName: string) => [
  param(paramName)
    .isUUID()
    .withMessage(`Invalid ${paramName}`),
];
