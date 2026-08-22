import { Router } from 'express';
import { logSuccessfulPayment, getPaymentHistory } from '../controllers/payment.controller';

const router = Router();

// POST /api/payments -> Log a successful payment
router.post('/', logSuccessfulPayment);

// GET /api/payments -> Get payment history
router.get('/', getPaymentHistory);

export default router;
