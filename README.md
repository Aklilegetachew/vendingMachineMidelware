# AFen Vending Machine & EthSwitch/Telebirr Interoperable QR Middleware

Production-ready Node.js/TypeScript middleware service connecting **AFen (TCN) Android-based Smart Vending Machines** with **Ethiopia's National Interoperable QR Payment Standard (NBE / EthSwitch IPS ET)**.

---

## 🌟 Features

- **EMVCo & EthSwitch Dynamic QR Engine**: Generates Tag-Length-Value (TLV) QR codes conforming strictly to NBE specification tags (00, 01, 28, 52, 53, 54, 58, 59, 60, 62, 63).
- **Pure CRC-16/CCITT-FALSE Verification**: Built-in 100% compliant CRC-16 calculation (Polynomial `0x1021`, Init `0xFFFF`).
- **AFen Vending Hardware Integration**: Endpoints for dynamic pay initiation (`/api/vending/pay`) and high-frequency pickup polling (`/api/vending/vend`).
- **Payment Gateway Webhook Callback**: Handles incoming payment verification from Telebirr, CBE Birr, and EthSwitch IPS ET (`/api/webhooks/payment`).
- **Interactive Swagger Documentation**: Explore and test endpoints live via Swagger UI at `/api-docs`.
- **Developer Workbench**: Built-in real-time UI at `/workbench` with SSE request traffic streaming, order status tables, and customer payment simulation tools.
- **Flexible Environment Database Credentials**: Supports SQLite, PostgreSQL, and MySQL dynamically configured via `.env` credentials (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`).

---

## 🚀 Quick Start

### 1. Installation

```bash
# Install dependencies
npm install

# Push Prisma schema to database
npm run prisma:push
```

### 2. Running in Development Mode

```bash
npm run dev
```

Server will launch on `http://localhost:3000`:
- **Swagger API Docs**: `http://localhost:3000/api-docs`
- **Developer Workbench**: `http://localhost:3000/workbench`
- **Root Health Check**: `http://localhost:3000/`

---

## ⚙️ Environment Configuration (`.env`)

You can configure database credentials individually in `.env`. The system dynamically constructs the database connection string.

```env
PORT=3000
NODE_ENV=development

# Database Credentials Configuration
# Options for DB_TYPE: sqlite | postgresql | mysql
DB_TYPE=sqlite
DB_HOST=localhost
DB_PORT=5432
DB_USER=vending_user
DB_PASSWORD=secret_password
DB_NAME=vending_db

# Optional Direct Connection String Override
DATABASE_URL="file:./dev.db"

# EthSwitch / NBE Dynamic QR Parameters
ETH_GUID="581b314e257f41bfbbdc6384daa31d16"
ACQUIRER_BIC="CBETETAA"
MERCHANT_ACCOUNT="0000171234567890"
MERCHANT_NAME="AFen Smart Vending"
MERCHANT_CITY="ADDIS ABABA"
MCC="5999"
CURRENCY_CODE="586"
COUNTRY_CODE="ET"
```

---

## 📖 Interactive Swagger API Documentation

Open `http://localhost:3000/api-docs` in your browser to access the complete OpenAPI 3.0 specification with interactive schemas and request/response examples.

![Swagger UI](http://localhost:3000/api-docs)

---

## 📡 API Endpoints Overview

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/` | Root Health Check (Status, uptime, DB latency check) |
| `GET` | `/api-docs` | Interactive Swagger API Documentation |
| `GET` | `/workbench` | Developer Workbench UI with live SSE event feed |
| `POST` | `/api/vending/pay` | Electric Pay (AFen Vending Machine QR generation) |
| `GET`/`POST` | `/api/vending/vend` | Electric Pickup Polling (Dispense authorization check) |
| `POST` | `/api/payment/telebirr/initiate` | Telebirr preOrder + signed checkout URL for an order |
| `POST` | `/api/webhooks/telebirr` | Telebirr notify callback (RSA-verified, then `queryOrder`) |
| `GET` | `/pay/telebirr/return` | Telebirr browser landing page (cosmetic; never fulfils) |
| `POST` | `/api/webhooks/payment` | Sandbox-only payment simulator (gated, see below) |
| `ALL` | `/test/pay` | Diagnostic catch-all logging for `/pay` traffic |
| `ALL` | `/test/vend` | Diagnostic catch-all logging for `/vend` traffic |

---

## 💳 Telebirr Payments

Live checkout runs through the Ethio Telebirr **Fabric gateway**: apply a fabric
token → `preOrder` → redirect to the signed paygate URL → receive the async
notify callback.

Set the `TELE_*` variables in `.env` (see `.env.example` for the annotated
list). `TELE_FABRIC_APP_ID` and `TELE_MERCHANT_APP_ID` are **different values**;
swapping them produces an opaque signature error, not a helpful one. If any
required variable is missing, `/api/payment/telebirr/initiate` fails with the
complete list of what is absent.

**An order is only marked `PAID` when the callback's RSA signature verifies, or
when `queryOrder` — a signed server-to-server request — confirms it.** A
callback is untrusted input from the public internet, so it never dispenses on
its own. Every callback is written verbatim to `TrafficLog` before parsing,
under `telebirr:*` endpoints; that log is the evidence trail for disputes.

`TELE_NOTIFY_URL` must be publicly reachable over HTTPS — it is baked into each
`preOrder`, so localhost means no payment is ever confirmed. Use ngrok in
development.

### Sandbox shortcuts

`/pay/mock-telebirr`, the "Instant Sandbox Payment" button, and
`/api/webhooks/payment` mark orders `PAID` with no gateway involvement. They
return `404` unless `TELE_ALLOW_SANDBOX_PAY=true` **and** `NODE_ENV` is not
`production`.

---

## 🧪 Automated Testing

Execute unit tests to verify the CRC-16 CCITT-FALSE calculation and EMVCo TLV QR generation:

```bash
npm test
```

---

## 🛠️ Project Structure

```
├── src/
│   ├── config/
│   │   ├── index.ts          # Environment & dynamic DB URL builder
│   │   └── swagger.ts        # OpenAPI 3.0 specification & Swagger UI
│   ├── utils/
│   │   ├── crc16.ts          # Pure CRC-16/CCITT-FALSE implementation
│   │   └── tlvEncoder.ts     # EMVCo TLV Encoder helper
│   ├── services/
│   │   ├── qrEngine.ts       # EthSwitch QR generation service
│   │   ├── orderStore.ts     # Persistent Prisma order state machine
│   │   └── eventBroadcaster.ts # SSE real-time log broadcaster
│   ├── controllers/
│   │   ├── vendingController.ts # AFen pay & vend handlers
│   │   ├── webhookController.ts # Sandbox-only payment simulator callback
│   │   ├── telebirrController.ts # Telebirr initiate / notify / return
│   │   ├── testController.ts    # Catch-all diagnostic handler
│   │   └── health.controller.ts # Service health status handler
│   ├── views/
│   │   └── index.html        # Developer Workbench UI
│   ├── app.ts                # Express application setup
│   ├── server.ts             # HTTP server entrypoint
│   └── index.ts              # Main entrypoint
├── tests/
│   ├── crc16.test.ts         # Unit test for CRC-16 checksums
│   └── qrEngine.test.ts      # Unit test for EMVCo TLV QR formatting
├── prisma/
│   └── schema.prisma         # Prisma ORM schema
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```
