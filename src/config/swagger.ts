import { Express } from 'express';
import swaggerUi from 'swagger-ui-express';

export const swaggerDocument = {
  openapi: '3.0.0',
  info: {
    title: 'TOMOCA Coffee Vending & EthSwitch/Telebirr QR Middleware API',
    version: '1.2.0',
    description:
      'Production-ready middleware connecting TOMOCA Coffee vending units and AFen (TCN) Android Smart Vending Machines with Ethiopia\'s National Interoperable QR Payment Standard (NBE / EthSwitch IPS ET) and Mobile EJS Checkout with Telebirr H5 Integration.',
    contact: {
      name: 'TOMOCA Coffee Vending Engineering',
    },
  },
  servers: [
    {
      url: 'http://localhost:3000',
      description: 'Local Development Server',
    },
  ],
  paths: {
    '/': {
      get: {
        summary: 'Root Health Check',
        description: 'Returns middleware service health, database connectivity status, query latency, uptime, and memory statistics.',
        tags: ['Health'],
        responses: {
          '200': { description: 'System healthy' },
        },
      },
    },
    '/pay': {
      get: {
        summary: 'Mobile Web Checkout Landing Page (GET /pay)',
        description: 'Pure presentation view rendered when customer scans vending QR code (`/pay?mid=2504150044&sid=1&pid=1&pri=70.00`). Renders `views/checkout.ejs` in Warm Orange theme.',
        tags: ['Mobile Web Checkout'],
        parameters: [
          { name: 'mid', in: 'query', required: true, schema: { type: 'string' }, example: '2504150044', description: 'Machine ID' },
          { name: 'sid', in: 'query', required: true, schema: { type: 'integer' }, example: 1, description: 'Slot Number' },
          { name: 'pid', in: 'query', required: true, schema: { type: 'string' }, example: '1', description: 'Product ID' },
          { name: 'pri', in: 'query', required: true, schema: { type: 'string' }, example: '70.00', description: 'Price in ETB' },
        ],
        responses: {
          '200': { description: 'HTML rendered checkout landing page' },
        },
      },
    },
    '/pay/success': {
      get: {
        summary: 'Completion & Dispense Verification Page (GET /pay/success)',
        description: 'Displays dynamic status card (initial orange spinner -> 1.5s polling -> green success dispense card or 30s timeout). Renders `views/success.ejs`.',
        tags: ['Mobile Web Checkout'],
        parameters: [
          { name: 'orderNo', in: 'query', required: true, schema: { type: 'string' }, example: 'ORD-1718000000000-1234', description: 'Target Order Number' },
        ],
        responses: {
          '200': { description: 'HTML rendered completion/dispense status page' },
        },
      },
    },
    '/api/payment/telebirr/initiate': {
      post: {
        summary: 'Initiate Telebirr H5 Payment',
        description: 'Generates Telebirr H5 web checkout link with RSA signature for the order.',
        tags: ['Telebirr Integration'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              example: { orderNo: 'ORD-1718000000000-1234' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Returns H5 pay URL',
            content: {
              'application/json': {
                example: { success: true, toPayUrl: 'https://telebirr.et/pay?...' },
              },
            },
          },
        },
      },
    },
    '/api/webhooks/telebirr': {
      post: {
        summary: 'Telebirr IPN Webhook Callback',
        description: 'Receives payment completion callback from Telebirr and marks order as `PAID`.',
        tags: ['Telebirr Integration'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              example: { orderNo: 'ORD-1718000000000-1234', outTradeNo: 'ORD-1718000000000-1234', totalAmount: '70.00' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Webhook processed',
            content: {
              'application/json': {
                example: { code: 0, msg: 'success' },
              },
            },
          },
        },
      },
    },
    '/vend': {
      get: {
        summary: 'Direct AFen Machine Polling Hook (GET /vend)',
        description: 'Polled directly by AFen machine (`/vend?mid=2504150044`). Responds with dispense command once order is PAID.',
        tags: ['AFen Direct Vending Hook'],
        parameters: [
          { name: 'mid', in: 'query', required: true, schema: { type: 'string' }, example: '2504150044' },
          { name: 'orderNo', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Dispense instruction response',
            content: {
              'application/json': {
                examples: {
                  Waiting: { value: { code: 0, status: 'WAITING', paid: false } },
                  VendCommand: { value: { code: 0, status: 'SUCCESS', paid: true, action: 'VEND', slotNo: 1 } },
                },
              },
            },
          },
        },
      },
      post: {
        summary: 'Direct AFen Machine Polling Hook (POST /vend)',
        description: 'Polled directly by AFen machine using JSON payload.',
        tags: ['AFen Direct Vending Hook'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              example: { machineId: '2504150044', orderNo: 'ORD-1718000000000-1234' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Dispense instruction response',
          },
        },
      },
    },
    '/api/orders/{orderNo}/status': {
      get: {
        summary: 'Checkout Client Status Polling API',
        description: 'Polled by `checkout.ejs` frontend every 2s to detect payment confirmation.',
        tags: ['Mobile Web Checkout'],
        parameters: [
          { name: 'orderNo', in: 'path', required: true, schema: { type: 'string' }, example: 'ORD-1718000000000-1234' },
        ],
        responses: {
          '200': {
            description: 'Order status state',
            content: {
              'application/json': {
                example: { orderNo: 'ORD-1718000000000-1234', status: 'PAID', paid: true },
              },
            },
          },
        },
      },
    },
  },
};

export function setupSwagger(app: Express): void {
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
}
