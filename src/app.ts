import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';

import {
  renderCheckoutPage,
  renderSuccessPage,
  handleDirectVendPoll,
  getOrderStatus,
  renderMockTelebirrPage,
  getCheckoutSession,
} from './controllers/checkoutController';
import {
  initiateTelebirrPayment,
  handleTelebirrNotify,
  handleTelebirrReturn,
  createMiniAppOrder,
  miniAppAuthToken,
} from './controllers/telebirrController';
import { sandboxPaymentsAllowed } from './config/telebirr';
import { handleVendingPay, handleVendingVend } from './controllers/vendingController';
import { handlePaymentWebhook } from './controllers/webhookController';
import { handleTestDiagnostics } from './controllers/testController';
import { getHealthStatus } from './controllers/health.controller';
import {
  renderBridgeCheck,
  reportBridgeCheck,
  getTelebirrLog,
  getOrderDashboardData,
  renderDashboard,
  armVendTest,
  getVendTest,
  disarmVendTest,
} from './controllers/diagnosticsController';
import { orderStore } from './services/orderStore';
import { eventBroadcaster } from './services/eventBroadcaster';
import { setupSwagger } from './config/swagger';
import { errorHandler } from './middleware/errorHandler';

const app: Express = express();

// Running behind nginx. Without this, req.ip is the proxy's address, which
// would make the Telebirr callback audit log record 127.0.0.1 for every
// notification instead of the address it actually arrived from.
app.set('trust proxy', 1);

// Configure View Engine & Static Directory
app.set('view engine', 'ejs');
app.set('views', path.join(process.cwd(), 'views'));
app.use(express.static(path.join(process.cwd(), 'public')));

// Security & Utility Middleware
app.use(
  helmet({
    contentSecurityPolicy: false, // Allow Tailwind CDN & FontAwesome for checkout views
  })
);
app.use(cors());
app.use(morgan('dev'));

// Telebirr notify MUST be registered before the JSON/urlencoded parsers so the
// raw body survives: it is needed verbatim for the audit log, and Telebirr
// posts it in three different shapes (JSON, form, and JSON-as-a-form-key).
app.post('/api/webhooks/telebirr', express.raw({ type: '*/*' }), handleTelebirrNotify);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Setup Swagger UI at /api-docs
setupSwagger(app);

// Serve Developer Workbench UI
app.get('/workbench', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// Mobile Web Checkout (Option A) Dual-Page Routes
app.get('/pay', renderCheckoutPage);
app.get('/pay/success', renderSuccessPage);
app.post('/api/payment/telebirr/initiate', initiateTelebirrPayment);

// Mini App (InApp) endpoints, called from inside the telebirr SuperApp.
app.post('/api/payment/telebirr/miniapp/order', createMiniAppOrder);
app.post('/api/payment/telebirr/miniapp/auth', miniAppAuthToken);
app.get('/pay/telebirr/return', handleTelebirrReturn);

// Bridge diagnostics: open /pay/bridge-check on the phone inside the SuperApp
// and watch the result arrive in the /workbench feed.
app.get('/pay/bridge-check', renderBridgeCheck);
app.post('/api/diagnostics/bridge', reportBridgeCheck);

// Operations dashboard: which orders got paid, and what Telebirr actually sent.
app.get('/dashboard', renderDashboard);
app.get('/api/diagnostics/orders', getOrderDashboardData);
app.get('/api/diagnostics/telebirr-log', getTelebirrLog);

// Dispense experiments: arm a command, watch what the machine does.
app.post('/api/vend-test/arm', armVendTest);
app.get('/api/vend-test', getVendTest);
app.post('/api/vend-test/disarm', disarmVendTest);
app.get('/api/orders/:orderNo/status', getOrderStatus);
app.get('/api/checkout/session', getCheckoutSession);

// Sandbox simulator: marks orders paid with no gateway involvement, so it is
// off unless TELE_ALLOW_SANDBOX_PAY=true and NODE_ENV is not production.
app.get('/pay/mock-telebirr', (req: Request, res: Response, next) => {
  if (!sandboxPaymentsAllowed()) {
    res.status(404).send('Not found');
    return;
  }
  void renderMockTelebirrPage(req, res).catch(next);
});

// Direct AFen Machine Polling Hook (/vend)
app.post('/vend', handleDirectVendPoll);
app.get('/vend', handleDirectVendPoll);

// AFen Vending Machine Prefix Endpoints (/api/vending/pay & /api/vending/vend)
app.post('/api/vending/pay', handleVendingPay);
app.post('/api/vending/vend', handleVendingVend);
app.get('/api/vending/vend', handleVendingVend);

// Legacy generic payment webhook. It marks an order PAID from an unsigned,
// unauthenticated body, so it is gated with the other sandbox shortcuts to stop
// it drifting into a second, weaker way of getting free product. Real Telebirr
// callbacks go to /api/webhooks/telebirr, which verifies before it fulfils.
app.post('/api/webhooks/payment', (req: Request, res: Response, next) => {
  if (!sandboxPaymentsAllowed()) {
    res.status(404).json({ success: false, message: 'Not found' });
    return;
  }
  void handlePaymentWebhook(req, res).catch(next);
});

// SSE Live Stream Endpoint
app.get('/api/events', (req: Request, res: Response) => {
  const clientId = `client_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  eventBroadcaster.addClient(clientId, res);
});

// Orders API for Workbench
app.get('/api/orders', async (_req: Request, res: Response) => {
  const orders = await orderStore.getRecentOrders(50);
  res.json({ orders });
});

// Health check endpoint
app.get('/', getHealthStatus);

// Catch-All Diagnostic Endpoints
app.all('/test/pay', handleTestDiagnostics);
app.all('/test/vend', handleTestDiagnostics);

// Error Handler
app.use(errorHandler);

export default app;
