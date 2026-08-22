import { Router } from 'express';
import { getHealthStatus } from '../controllers/health.controller';

const router = Router();

// GET / -> Health check endpoint
router.get('/', getHealthStatus);

export default router;
